import { CLASSIFICATION_VERSION, detectTheme } from "@/lib/classification/rules";
import type { SourceColumn, SourceRow } from "@/lib/ingest/columns";
import { CsvStructureError, type ParsedCsvRecord } from "@/lib/ingest/csv";
import { analyzeRecords, type FileStats } from "@/lib/ingest/file";
import type { RowError, TransformedRow } from "@/lib/ingest/transform";
import { TEMPLATE_EXAMPLE_MARKER } from "./constants";
import { normalizeTimestampText } from "./normalize";
import type { UploadContents } from "./read-upload";

/**
 * Web-import validation. Pure: the worker runs it on the uploaded file, and the
 * tests run it on fixtures. It reuses the CLI's row validation (analyzeRecords)
 * and adds the checks a spreadsheet upload needs. Nothing is ever dropped
 * silently: every rejected row becomes a staged invalid row with its reason.
 */

export type IssueSeverity = "error" | "warning" | "info";

export interface ImportIssue {
  severity: IssueSeverity;
  code: string;
  row_number?: number;
  line?: number;
  ticket_id?: number | null;
  column_name?: string;
  message: string;
  value_excerpt?: string;
}

export interface StagedAttachment {
  attachment_type: "request" | "response";
  position: number;
  url: string;
  url_host: string | null;
  file_name: string | null;
  file_extension: string | null;
}

export interface StageRow {
  row_number: number;
  line: number;
  ticket_id: number | null;
  organization_id: number | null;
  row_hash: string | null;
  is_valid: boolean;
  record: Record<string, unknown> | null;
  attachments: StagedAttachment[];
  theme: { subcategory: string; confidence: number | null; matched_terms: string[]; theme_scores: Record<string, number>; version: string } | null;
  raw: SourceRow | null;
  error_code: string | null;
  error_message: string | null;
}

export interface ValidationContext {
  project: { code: string; organization_id: number };
  /** Status values configured as open/closed (including "__none__"). */
  configuredStatuses: Set<string>;
  /** Topics mapped to an analytical category. */
  mappedTopics: Set<string>;
  now: Date;
}

export interface ValidationSummary {
  rows_total: number;
  rows_valid: number;
  rows_invalid: number;
  format: string;
  sheet?: string;
  delimiter?: string;
  by_code: Record<string, { severity: IssueSeverity; count: number }>;
  organization_filled: number;
  new_topics: { topic: string; rows: number }[];
  unconfigured_statuses: { status: string; rows: number }[];
  stats: FileStats;
}

export interface ValidationOutcome {
  stageRows: StageRow[];
  /** Row-level findings (capped per code for warnings/notes; errors are never capped). */
  rowIssues: ImportIssue[];
  fileIssues: ImportIssue[];
  summary: ValidationSummary;
}

const TIMESTAMP_COLUMNS: SourceColumn[] = ["Created_At", "Responded_At", "Resolved_At"];
/** Free-text columns: never copied into issue excerpts. */
const FREE_TEXT: SourceColumn[] = ["Message", "Response", "Note"];
const TEXT_INTEGRITY_COLUMNS: SourceColumn[] = ["Topic", "Message", "Response", "Note", "Responder_Name", "Resolved_By"];
const MOJIBAKE = /(?:Ø|Ù|Ú|Û)[\u0080-¿‐-›ŒœŠšŸŽžˆ˜]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CAP = { error: Number.POSITIVE_INFINITY, warning: 5000, info: 200 } as const;

const COLUMN_ERROR_CODE: Partial<Record<string, string>> = {
  Ticket_ID: "INVALID_TICKET_ID",
  Created_At: "INVALID_TIMESTAMP",
  Responded_At: "INVALID_TIMESTAMP",
  Resolved_At: "INVALID_TIMESTAMP",
  Organization_ID: "INVALID_ORGANIZATION_ID",
  Status: "UNSUPPORTED_STATUS_FORMAT",
};

function excerpt(column: string, value: string | undefined): string | undefined {
  if (value === undefined || (FREE_TEXT as string[]).includes(column)) return undefined;
  const v = value.trim();
  return v === "" ? undefined : v.slice(0, 120);
}

class IssueCollector {
  readonly rowIssues: ImportIssue[] = [];
  readonly counts: Record<string, { severity: IssueSeverity; count: number }> = {};

  add(issue: ImportIssue): void {
    const entry = (this.counts[issue.code] ??= { severity: issue.severity, count: 0 });
    entry.count++;
    if (entry.count <= CAP[issue.severity]) this.rowIssues.push(issue);
  }

  count(code: string, severity: IssueSeverity, n: number): void {
    if (n <= 0) return;
    const entry = (this.counts[code] ??= { severity, count: 0 });
    entry.count += n;
  }
}

/** The parts of a transformed row the database needs to (re)create a ticket. */
function stageRecord(row: TransformedRow): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...row.record };
  delete rest.source_row_number;
  delete rest.row_hash;
  return rest;
}

export function validateUpload(contents: UploadContents, ctx: ValidationContext): ValidationOutcome {
  const records = contents.parsed.records;
  if (records.length === 0) {
    throw new CsvStructureError("The file has the template header but no ticket rows.", "NO_DATA_ROWS");
  }
  const issues = new IssueCollector();
  for (const i of contents.cellIssues) issues.add(i);
  const expectedOrg = ctx.project.organization_id;

  // 1. Which project does the file belong to? Refuse a file exported for another organization.
  const orgCounts = new Map<string, number>();
  for (const r of records) {
    const org = r.values.Organization_ID.trim();
    if (org !== "") orgCounts.set(org, (orgCounts.get(org) ?? 0) + 1);
  }
  const withOrg = [...orgCounts.values()].reduce((a, b) => a + b, 0);
  const matching = orgCounts.get(String(expectedOrg)) ?? 0;
  if (withOrg > 0 && matching / withOrg < 0.5) {
    const found = [...orgCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o, n]) => `${o} (${n} rows)`).join(", ");
    throw new CsvStructureError(
      `This file does not belong to ${ctx.project.code}: most rows carry Organization_ID ${found}, but the project uses ${expectedOrg}. Choose the matching project or check the export.`,
      "ORGANIZATION_NOT_FOUND",
    );
  }

  // 2. Normalize values (timestamps, empty Organization_ID) and pre-check rows.
  let organizationFilled = 0;
  const excelDates = contents.excelDates;
  const preRejected: RowError[] = [];
  const toAnalyze: ParsedCsvRecord[] = [];
  const rawByRow = new Map<number, SourceRow>();
  const lineByRow = new Map<number, number>();

  for (const rec of records) {
    rawByRow.set(rec.rowNumber, rec.values);
    lineByRow.set(rec.rowNumber, rec.line);
    const values = { ...rec.values };
    const idGuess = /^\d{1,15}$/.test(values.Ticket_ID.trim()) ? Number(values.Ticket_ID.trim()) : null;
    const base = { row_number: rec.rowNumber, line: rec.line, ticket_id: idGuess };

    for (const col of TIMESTAMP_COLUMNS) {
      const n = normalizeTimestampText(values[col]);
      if (n.note === "assumed_cairo" || excelDates.get(rec.rowNumber)?.includes(col)) {
        issues.add({ ...base, severity: "info", code: "TIMESTAMP_ASSUMED_CAIRO", column_name: col, value_excerpt: excerpt(col, values[col]),
          message: `${col} had no UTC offset${excelDates.get(rec.rowNumber)?.includes(col) ? " (Excel date)" : ""}; read as Africa/Cairo local time → ${n.value}.` });
      } else if (n.note === "converted") {
        issues.add({ ...base, severity: "info", code: "TIMESTAMP_CONVERTED", column_name: col, value_excerpt: excerpt(col, values[col]),
          message: `${col} converted to the export format → ${n.value}.` });
      }
      values[col] = n.value;
    }
    if (values.Organization_ID.trim() === "") {
      values.Organization_ID = String(expectedOrg);
      organizationFilled++;
    }

    const sample = [values.Message, values.Note, values.Response].some((v) => v.includes(TEMPLATE_EXAMPLE_MARKER));
    const corrupted = TEXT_INTEGRITY_COLUMNS.find((c) => values[c].includes("�"));
    if (sample || corrupted) {
      const code = sample ? "SAMPLE_ROW" : "TEXT_ENCODING";
      const message = sample
        ? "This is an example row copied from the template (it contains the example marker) and is never imported."
        : `${corrupted} contains replacement characters (�): the text was corrupted before upload. Re-export the file as UTF-8.`;
      preRejected.push({ rowNumber: rec.rowNumber, line: rec.line, ticketId: idGuess, code, message, raw: rec.values, column: sample ? undefined : corrupted });
      continue;
    }
    toAnalyze.push({ ...rec, values });
  }
  issues.count("ORGANIZATION_FILLED", "info", organizationFilled);

  // 3. Shared row validation (format, required values, organization, duplicates).
  const analysis = analyzeRecords(toAnalyze, ctx.project);
  const errors = [...preRejected, ...analysis.errors].sort((a, b) => a.rowNumber - b.rowNumber);
  const stats: FileStats = {
    ...analysis.stats,
    records_in_file: records.length,
    rejected: analysis.stats.rejected + preRejected.length,
  };

  for (const e of errors) {
    const base = { row_number: e.rowNumber, line: e.line, ticket_id: e.ticketId };
    if (e.code === "VALIDATION_FAILED" && e.issues?.length) {
      for (const i of e.issues) {
        const raw = rawByRow.get(e.rowNumber);
        const code = i.message === "is required" ? "MISSING_REQUIRED" : (COLUMN_ERROR_CODE[i.column] ?? "VALIDATION_FAILED");
        issues.add({ ...base, severity: "error", code, column_name: i.column, value_excerpt: excerpt(i.column, raw?.[i.column as SourceColumn]),
          message: `${i.column} ${i.message}.` });
      }
    } else {
      issues.add({ ...base, severity: "error", code: e.code, column_name: e.column, message: e.message,
        value_excerpt: e.column ? excerpt(e.column, rawByRow.get(e.rowNumber)?.[e.column as SourceColumn]) : undefined });
    }
  }

  // 4. Data-quality warnings on accepted rows (non-blocking).
  const now = ctx.now.getTime();
  const statusCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  for (const row of analysis.rows) {
    const r = row.record;
    const base = { row_number: r.source_row_number, line: lineByRow.get(r.source_row_number), ticket_id: r.ticket_id };
    const c = row.createdEpochMs;
    const resp = row.respondedEpochMs;
    const res = row.resolvedEpochMs;
    if (resp !== null && resp < c) issues.add({ ...base, severity: "warning", code: "TIMESTAMP_ORDER", column_name: "Responded_At", message: "Responded_At is before Created_At." });
    if (res !== null && res < c) issues.add({ ...base, severity: "warning", code: "TIMESTAMP_ORDER", column_name: "Resolved_At", message: "Resolved_At is before Created_At." });
    else if (resp !== null && res !== null && res < resp) issues.add({ ...base, severity: "warning", code: "TIMESTAMP_ORDER", column_name: "Resolved_At", message: "Resolved_At is before Responded_At." });
    if (row.latestEpochMs > now + 24 * 3600_000) issues.add({ ...base, severity: "warning", code: "FUTURE_TIMESTAMP", message: "A timestamp lies in the future." });
    if (row.offsetMismatches > 0) issues.add({ ...base, severity: "warning", code: "OFFSET_NOT_CAIRO", message: `UTC offset ${row.offsets.join(", ")} differs from Cairo time on that date (the instant itself is stored exactly).` });
    if (row.invalidAttachmentTokens > 0) issues.add({ ...base, severity: "warning", code: "ATTACHMENT_URL_INVALID", column_name: "Attachment_URLs", message: `${row.invalidAttachmentTokens} attachment value(s) are not http(s) URLs.` });
    if (r.status === "completed" && res === null) issues.add({ ...base, severity: "warning", code: "STATUS_TIMESTAMP_MISMATCH", column_name: "Status", message: "Status is completed but Resolved_At is empty." });
    if (r.status === "pending" && res !== null) issues.add({ ...base, severity: "warning", code: "STATUS_TIMESTAMP_MISMATCH", column_name: "Status", message: "Status is pending but Resolved_At is set." });
    for (const col of ["message", "response", "note"] as const) {
      const text = r[col];
      if (!text) continue;
      const label = col === "message" ? "Message" : col === "response" ? "Response" : "Note";
      if ((text.match(MOJIBAKE)?.length ?? 0) >= 3) issues.add({ ...base, severity: "warning", code: "MOJIBAKE_SUSPECTED", column_name: label, message: `${label} looks garbled (Arabic decoded with the wrong encoding).` });
      if (CONTROL.test(text)) issues.add({ ...base, severity: "warning", code: "CONTROL_CHARACTERS", column_name: label, message: `${label} contains invisible control characters.` });
    }
    const statusKey = r.status ?? "__none__";
    if (!ctx.configuredStatuses.has(statusKey)) statusCounts.set(statusKey, (statusCounts.get(statusKey) ?? 0) + 1);
    if (!ctx.mappedTopics.has(r.topic.trim())) topicCounts.set(r.topic.trim(), (topicCounts.get(r.topic.trim()) ?? 0) + 1);
  }

  const fileIssues: ImportIssue[] = [...contents.fileIssues];
  if (organizationFilled > 0) {
    fileIssues.push({ severity: "info", code: "ORGANIZATION_FILLED", column_name: "Organization_ID",
      message: `Organization_ID was empty in ${organizationFilled} row(s) and was set to ${expectedOrg} (${ctx.project.code}).` });
  }
  for (const [status, n] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
    issues.count("STATUS_NOT_CONFIGURED", "warning", n);
    fileIssues.push({ severity: "warning", code: "STATUS_NOT_CONFIGURED", column_name: "Status", value_excerpt: status === "__none__" ? undefined : status.slice(0, 120),
      message: `Status "${status === "__none__" ? "(empty)" : status}" (${n} rows) is not classified as open or closed yet; it counts as open in backlog figures until an administrator classifies it in Settings → Categories.` });
  }
  for (const [topic, n] of [...topicCounts.entries()].sort((a, b) => b[1] - a[1])) {
    issues.count("TOPIC_UNMAPPED", "warning", n);
    fileIssues.push({ severity: "warning", code: "TOPIC_UNMAPPED", column_name: "Topic", value_excerpt: topic.slice(0, 120),
      message: `New topic "${topic.slice(0, 80)}" (${n} rows) is not mapped to a category; it is counted as Uncategorized until mapped in Settings → Categories.` });
  }
  for (const f of contents.fileIssues) issues.count(f.code, f.severity, 1);

  // 5. Staging payload: every row of the file, valid or not.
  const stageRows: StageRow[] = [];
  for (const row of analysis.rows) {
    const theme = detectTheme(row.details);
    stageRows.push({
      row_number: row.record.source_row_number,
      line: lineByRow.get(row.record.source_row_number) ?? row.record.source_row_number + 1,
      ticket_id: row.record.ticket_id,
      organization_id: row.record.organization_id,
      row_hash: row.record.row_hash,
      is_valid: true,
      record: stageRecord(row),
      attachments: row.attachments.map((a) => ({
        attachment_type: a.attachmentType,
        position: a.position,
        url: a.url,
        url_host: a.host,
        file_name: a.fileName,
        file_extension: a.extension,
      })),
      theme: { subcategory: theme.subcategory, confidence: theme.confidence, matched_terms: theme.matchedTerms, theme_scores: theme.scores as Record<string, number>, version: CLASSIFICATION_VERSION },
      raw: null,
      error_code: null,
      error_message: null,
    });
  }
  for (const e of errors) {
    stageRows.push({
      row_number: e.rowNumber,
      line: e.line,
      ticket_id: e.ticketId,
      organization_id: null,
      row_hash: null,
      is_valid: false,
      record: null,
      attachments: [],
      theme: null,
      raw: rawByRow.get(e.rowNumber) ?? e.raw,
      error_code: e.code,
      error_message: e.message.slice(0, 1000),
    });
  }
  stageRows.sort((a, b) => a.row_number - b.row_number);

  return {
    stageRows,
    rowIssues: issues.rowIssues,
    fileIssues,
    summary: {
      rows_total: records.length,
      rows_valid: analysis.rows.length,
      rows_invalid: errors.length,
      format: contents.format,
      sheet: contents.sheet,
      delimiter: contents.delimiter,
      by_code: issues.counts,
      organization_filled: organizationFilled,
      new_topics: [...topicCounts.entries()].map(([topic, rows]) => ({ topic, rows })),
      unconfigured_statuses: [...statusCounts.entries()].map(([status, rows]) => ({ status, rows })),
      stats,
    },
  };
}
