import { createHash } from "node:crypto";
import { SOURCE_COLUMNS, type SourceColumn } from "./columns";
import { CsvStructureError, parseTicketCsv } from "./csv";
import { transformRecord, type RowError, type TransformedRow } from "./transform";

export interface ProjectRef {
  id: string;
  code: string;
  name: string;
  organization_id: number;
  file_name_hint: string;
}

export class ProjectMappingError extends Error {}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Maps a file to exactly one project.
 *
 *  - If the filename names a project (via projects.file_name_hint), that project
 *    is used, provided its Organization_ID accounts for most rows. Rows carrying
 *    any other Organization_ID are rejected individually (ORGANIZATION_MISMATCH).
 *  - Otherwise the file must contain a single Organization_ID that matches a
 *    configured project.
 *
 * Anything ambiguous rejects the whole file rather than importing it into the
 * wrong project.
 */
export function resolveProject(
  fileName: string,
  organizationCounts: Map<number, number>,
  projects: ProjectRef[],
): ProjectRef {
  if (organizationCounts.size === 0) {
    throw new ProjectMappingError("File contains no valid Organization_ID values.");
  }
  const total = [...organizationCounts.values()].reduce((a, b) => a + b, 0);
  const normalizedFile = normalizeName(fileName);
  const nameMatches = projects.filter((p) => normalizedFile.includes(normalizeName(p.file_name_hint)));

  if (nameMatches.length > 1) {
    throw new ProjectMappingError(
      `Filename matches several projects (${nameMatches.map((p) => p.code).join(", ")}).`,
    );
  }
  if (nameMatches.length === 1) {
    const project = nameMatches[0];
    const count = organizationCounts.get(project.organization_id) ?? 0;
    if (count / total < 0.5) {
      throw new ProjectMappingError(
        `Filename indicates ${project.code} (Organization_ID ${project.organization_id}) but the file contains ` +
          `Organization_IDs ${[...organizationCounts.keys()].join(", ")}.`,
      );
    }
    return project;
  }

  if (organizationCounts.size > 1) {
    throw new ProjectMappingError(
      `Filename does not identify a project and the file mixes Organization_IDs (${[...organizationCounts.keys()].join(", ")}).`,
    );
  }
  const orgId = [...organizationCounts.keys()][0];
  const byOrg = projects.find((p) => p.organization_id === orgId);
  if (!byOrg) {
    throw new ProjectMappingError(`Organization_ID ${orgId} does not match any configured project.`);
  }
  return byOrg;
}

export interface FileStats {
  records_in_file: number;
  accepted: number;
  rejected: number;
  distinct_ticket_ids: number;
  duplicate_ticket_ids_in_file: number;
  status_counts: Record<string, number>;
  missing: Record<SourceColumn, number>;
  anomalies: {
    resolved_before_responded: number;
    responded_before_created: number;
    resolved_before_created: number;
    completed_without_resolved_at: number;
    pending_with_resolved_at: number;
    responded_equals_resolved: number;
  };
  offsets: Record<string, number>;
  offset_mismatches_vs_cairo: number;
  multiline: { message: number; note: number; response: number };
  attachments: { request: number; response: number; invalid_tokens: number };
  min_created_at: string | null;
  max_created_at: string | null;
  data_as_of: string | null;
}

export interface ProcessedFile {
  fileName: string;
  fileHash: string;
  sizeBytes: number;
  project: ProjectRef;
  rows: TransformedRow[];
  errors: RowError[];
  stats: FileStats;
}

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function emptyMissing(): Record<SourceColumn, number> {
  return Object.fromEntries(SOURCE_COLUMNS.map((c) => [c, 0])) as Record<SourceColumn, number>;
}

/**
 * Parses, validates and maps one export file. Pure (no database access): the
 * importer and the validator share it so they always agree on the source data.
 */
export function processFile(fileName: string, buffer: Buffer, projects: ProjectRef[]): ProcessedFile {
  const fileHash = sha256(buffer);
  const parsed = parseTicketCsv(buffer);

  const orgCounts = new Map<number, number>();
  for (const rec of parsed.records) {
    const org = rec.values.Organization_ID.trim();
    if (/^\d{1,9}$/.test(org)) orgCounts.set(Number(org), (orgCounts.get(Number(org)) ?? 0) + 1);
  }
  const project = resolveProject(fileName, orgCounts, projects);

  const rows: TransformedRow[] = [];
  const errors: RowError[] = [];
  const missing = emptyMissing();
  let multilineMessage = 0;
  let multilineNote = 0;
  let multilineResponse = 0;

  for (const rec of parsed.records) {
    for (const col of SOURCE_COLUMNS) {
      if (rec.values[col].trim() === "") missing[col]++;
    }
    if (rec.values.Message.includes("\n")) multilineMessage++;
    if (rec.values.Note.includes("\n")) multilineNote++;
    if (rec.values.Response.includes("\n")) multilineResponse++;

    const result = transformRecord(rec);
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    if (result.row.record.organization_id !== project.organization_id) {
      errors.push({
        rowNumber: rec.rowNumber,
        line: rec.line,
        ticketId: result.row.record.ticket_id,
        code: "ORGANIZATION_MISMATCH",
        message: `Organization_ID ${result.row.record.organization_id} does not match project ${project.code} (${project.organization_id}).`,
        raw: rec.values,
      });
      continue;
    }
    rows.push(result.row);
  }

  // Duplicate ticket IDs inside one file: keep the row with the latest activity
  // (ties: the later row in the file) and reject the others explicitly.
  const byId = new Map<number, TransformedRow[]>();
  for (const row of rows) {
    const list = byId.get(row.record.ticket_id);
    if (list) list.push(row);
    else byId.set(row.record.ticket_id, [row]);
  }
  let duplicateIds = 0;
  const kept: TransformedRow[] = [];
  for (const [ticketId, list] of byId) {
    if (list.length === 1) {
      kept.push(list[0]);
      continue;
    }
    duplicateIds++;
    const sorted = [...list].sort(
      (a, b) => b.latestEpochMs - a.latestEpochMs || b.record.source_row_number - a.record.source_row_number,
    );
    kept.push(sorted[0]);
    for (const dup of sorted.slice(1)) {
      const rec = parsed.records[dup.record.source_row_number - 1];
      errors.push({
        rowNumber: dup.record.source_row_number,
        line: rec.line,
        ticketId,
        code: "DUPLICATE_TICKET_IN_FILE",
        message: `Ticket ${ticketId} appears ${list.length} times in this file; kept row ${sorted[0].record.source_row_number} (latest activity).`,
        raw: rec.values,
      });
    }
  }
  kept.sort((a, b) => a.record.source_row_number - b.record.source_row_number);
  errors.sort((a, b) => a.rowNumber - b.rowNumber);

  const statusCounts: Record<string, number> = {};
  const offsets: Record<string, number> = {};
  const anomalies = {
    resolved_before_responded: 0,
    responded_before_created: 0,
    resolved_before_created: 0,
    completed_without_resolved_at: 0,
    pending_with_resolved_at: 0,
    responded_equals_resolved: 0,
  };
  let offsetMismatches = 0;
  let reqAttachments = 0;
  let respAttachments = 0;
  let invalidTokens = 0;
  let minCreated = Number.POSITIVE_INFINITY;
  let maxCreated = Number.NEGATIVE_INFINITY;
  let dataAsOf = Number.NEGATIVE_INFINITY;

  for (const row of kept) {
    const r = row.record;
    const key = r.status ?? "__none__";
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    for (const o of row.offsets) offsets[o] = (offsets[o] ?? 0) + 1;
    offsetMismatches += row.offsetMismatches;
    invalidTokens += row.invalidAttachmentTokens;
    for (const a of row.attachments) {
      if (a.attachmentType === "request") reqAttachments++;
      else respAttachments++;
    }
    const c = row.createdEpochMs;
    const resp = row.respondedEpochMs;
    const res = row.resolvedEpochMs;
    if (resp !== null && res !== null && res < resp) anomalies.resolved_before_responded++;
    if (resp !== null && resp < c) anomalies.responded_before_created++;
    if (res !== null && res < c) anomalies.resolved_before_created++;
    if (r.status === "completed" && res === null) anomalies.completed_without_resolved_at++;
    if (r.status === "pending" && res !== null) anomalies.pending_with_resolved_at++;
    if (resp !== null && res !== null && resp === res) anomalies.responded_equals_resolved++;
    minCreated = Math.min(minCreated, c);
    maxCreated = Math.max(maxCreated, c);
    dataAsOf = Math.max(dataAsOf, row.latestEpochMs);
  }

  const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

  return {
    fileName,
    fileHash,
    sizeBytes: buffer.length,
    project,
    rows: kept,
    errors,
    stats: {
      records_in_file: parsed.records.length,
      accepted: kept.length,
      rejected: errors.length,
      distinct_ticket_ids: byId.size,
      duplicate_ticket_ids_in_file: duplicateIds,
      status_counts: statusCounts,
      missing,
      anomalies,
      offsets,
      offset_mismatches_vs_cairo: offsetMismatches,
      multiline: { message: multilineMessage, note: multilineNote, response: multilineResponse },
      attachments: { request: reqAttachments, response: respAttachments, invalid_tokens: invalidTokens },
      min_created_at: iso(minCreated),
      max_created_at: iso(maxCreated),
      data_as_of: iso(dataAsOf),
    },
  };
}

export { CsvStructureError };
