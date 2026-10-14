/**
 * Reconciles the database against the original CSV exports (full files, every row).
 *
 *   npm run db:validate
 *
 * Checks per file/project: record counts, row-level content hashes, status
 * counts, missing values per field, timestamp anomalies, and duration
 * statistics (recomputed independently in TypeScript and compared with SQL).
 * Exits non-zero on any mismatch.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { SOURCE_COLUMNS, type SourceColumn } from "@/lib/ingest/columns";
import { BRIEF_EXPECTED_COUNTS } from "@/lib/ingest/default-projects";
import { processFile, type ProcessedFile, type ProjectRef } from "@/lib/ingest/file";
import { median, percentileCont } from "@/lib/analytics/stats";
import { connect, type Sql } from "./lib/db";

type Level = "PASS" | "FAIL" | "WARN" | "INFO";
interface Check {
  scope: string;
  name: string;
  level: Level;
  expected: string;
  actual: string;
}

const checks: Check[] = [];
function record(scope: string, name: string, expected: unknown, actual: unknown, level?: Level): void {
  const e = typeof expected === "string" ? expected : JSON.stringify(expected);
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  checks.push({ scope, name, expected: e, actual: a, level: level ?? (e === a ? "PASS" : "FAIL") });
}

const DB_COLUMN: Record<SourceColumn, string | null> = {
  Ticket_ID: null,
  Topic: "topic",
  Message: "message",
  Status: "status",
  Priority: "priority",
  Department: "department",
  Owner_Type: "owner_type",
  Owner_ID: "owner_id",
  Affected_Student_ID: "affected_student_id",
  Created_At: null,
  Responded_At: "responded_at",
  Resolved_At: "resolved_at",
  Response: "response",
  Note: "note",
  Responder_Name: "responder_name",
  Resolved_By: "resolved_by",
  Organization_ID: null,
  Attachment_URLs: "attachment_urls",
  Response_Attachment_URLs: "response_attachment_urls",
};

function sortedObject(o: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

function round(n: number | null): number | null {
  return n === null ? null : Math.round(n);
}

async function validateFile(sql: Sql, pf: ProcessedFile): Promise<void> {
  const scope = pf.project.code;
  const pid = pf.project.id;

  record(scope, "file records = accepted + rejected", pf.stats.records_in_file, pf.stats.accepted + pf.stats.rejected);
  if (pf.errors.length > 0) {
    record(scope, "rows rejected by validation", 0, pf.errors.length, "WARN");
  }

  const dbRows = await sql<{ ticket_id: number; row_hash: string; source_filename: string }[]>`
    select ticket_id, row_hash, source_filename from public.tickets where project_id = ${pid}
  `;
  const dbById = new Map(dbRows.map((r) => [Number(r.ticket_id), r]));
  let missing = 0;
  let hashMismatch = 0;
  for (const row of pf.rows) {
    const db = dbById.get(row.record.ticket_id);
    if (!db) missing++;
    else if (db.row_hash !== row.record.row_hash) hashMismatch++;
  }
  const fileIds = new Set(pf.rows.map((r) => r.record.ticket_id));
  const extra = dbRows.filter((r) => !fileIds.has(Number(r.ticket_id))).length;

  record(scope, "tickets in database", pf.stats.accepted, dbRows.length);
  record(scope, "file tickets missing from database", 0, missing);
  record(scope, "row content hash mismatches", 0, hashMismatch);
  record(scope, "database tickets not in this file", 0, extra, extra === 0 ? "PASS" : "WARN");

  // Status counts
  const statusRows = await sql<{ k: string; n: number }[]>`
    select coalesce(status, '__none__') as k, count(*)::int as n from public.tickets where project_id = ${pid} group by 1
  `;
  record(scope, "status counts", sortedObject(pf.stats.status_counts), sortedObject(Object.fromEntries(statusRows.map((r) => [r.k, r.n]))));

  // Missing values per field
  const fileMissing: Record<string, number> = {};
  const dbMissing: Record<string, number> = {};
  for (const col of SOURCE_COLUMNS) {
    const dbCol = DB_COLUMN[col];
    fileMissing[col] = pf.stats.missing[col];
    if (dbCol === null) {
      dbMissing[col] = 0;
      continue;
    }
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.tickets where project_id = ${pid} and ${sql(dbCol)} is null
    `;
    dbMissing[col] = n;
  }
  record(scope, "missing values per field", fileMissing, dbMissing);

  // Anomalies
  const [a] = await sql<Record<string, number>[]>`
    select
      count(*) filter (where resolved_at < responded_at)::int as resolved_before_responded,
      count(*) filter (where responded_at < created_at)::int as responded_before_created,
      count(*) filter (where resolved_at < created_at)::int as resolved_before_created,
      count(*) filter (where status = 'completed' and resolved_at is null)::int as completed_without_resolved_at,
      count(*) filter (where status = 'pending' and resolved_at is not null)::int as pending_with_resolved_at,
      count(*) filter (where responded_at = resolved_at)::int as responded_equals_resolved
    from public.tickets where project_id = ${pid}
  `;
  record(scope, "timestamp anomalies", sortedObject(pf.stats.anomalies), sortedObject(a));

  // Durations: recompute from the file in TypeScript, compare with SQL.
  const resp = pf.rows.filter((r) => r.respondedEpochMs !== null).map((r) => (r.respondedEpochMs! - r.createdEpochMs) / 1000).filter((s) => s >= 0);
  const reso = pf.rows.filter((r) => r.resolvedEpochMs !== null).map((r) => (r.resolvedEpochMs! - r.createdEpochMs) / 1000).filter((s) => s >= 0);
  const [d] = await sql<{ rn: number; rmed: number | null; rp90: number | null; sn: number; smed: number | null; sp90: number | null }[]>`
    select
      count(*) filter (where response_seconds >= 0)::int as rn,
      round((percentile_cont(0.5) within group (order by response_seconds) filter (where response_seconds >= 0))::numeric)::float8 as rmed,
      round((percentile_cont(0.9) within group (order by response_seconds) filter (where response_seconds >= 0))::numeric)::float8 as rp90,
      count(*) filter (where resolution_seconds >= 0)::int as sn,
      round((percentile_cont(0.5) within group (order by resolution_seconds) filter (where resolution_seconds >= 0))::numeric)::float8 as smed,
      round((percentile_cont(0.9) within group (order by resolution_seconds) filter (where resolution_seconds >= 0))::numeric)::float8 as sp90
    from public.tickets where project_id = ${pid}
  `;
  record(
    scope,
    "recorded response duration (n, median s, p90 s)",
    [resp.length, round(median(resp)), round(percentileCont(resp, 0.9))],
    [d.rn, d.rmed, d.rp90],
  );
  record(
    scope,
    "resolution duration (n, median s, p90 s)",
    [reso.length, round(median(reso)), round(percentileCont(reso, 0.9))],
    [d.sn, d.smed, d.sp90],
  );

  const [att] = await sql<{ req: number; resp: number }[]>`
    select count(*) filter (where a.attachment_type = 'request')::int as req,
           count(*) filter (where a.attachment_type = 'response')::int as resp
    from public.ticket_attachments a join public.tickets t on t.ticket_id = a.ticket_id
    where t.project_id = ${pid}
  `;
  record(scope, "attachment references (request, response)", [pf.stats.attachments.request, pf.stats.attachments.response], [att.req, att.resp]);

  const [cls] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.ticket_classifications c join public.tickets t on t.ticket_id = c.ticket_id
    where t.project_id = ${pid} and c.is_current
  `;
  record(scope, "current classifications", pf.stats.accepted, cls.n);

  record(scope, "timestamp offsets inconsistent with Africa/Cairo", 0, pf.stats.offset_mismatches_vs_cairo, pf.stats.offset_mismatches_vs_cairo === 0 ? "PASS" : "WARN");

  const expected = BRIEF_EXPECTED_COUNTS[pf.project.code];
  if (expected !== undefined) {
    record(scope, "row count vs. project brief (initial export)", expected, pf.stats.records_in_file, expected === pf.stats.records_in_file ? "PASS" : "WARN");
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { dir: { type: "string", default: "data/raw" } } });
  const dir = path.resolve(values.dir!);
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv")).sort();
  if (files.length === 0) {
    console.error("No CSV files found in data/raw/.");
    return 1;
  }

  const { sql, target } = connect({ max: 2 });
  console.log(`Validating ${files.length} file(s) against ${target}\n`);
  try {
    const projects = await sql<ProjectRef[]>`select id, code, name, organization_id, file_name_hint from public.projects`;
    let fileTotal = 0;
    const allIds = new Set<number>();
    for (const f of files) {
      const pf = processFile(f, readFileSync(path.join(dir, f)), projects);
      fileTotal += pf.stats.accepted;
      for (const r of pf.rows) allIds.add(r.record.ticket_id);
      await validateFile(sql, pf);
    }
    const [{ total, distinct_ids }] = await sql<{ total: number; distinct_ids: number }[]>`
      select count(*)::int as total, count(distinct ticket_id)::int as distinct_ids from public.tickets
    `;
    record("ALL", "total tickets (files vs database)", fileTotal, total);
    record("ALL", "unique ticket IDs across files", fileTotal, allIds.size);
    record("ALL", "unique ticket IDs in database", total, distinct_ids);
    const briefTotal = Object.values(BRIEF_EXPECTED_COUNTS).reduce((a, b) => a + b, 0);
    record("ALL", "total vs. project brief (initial export)", briefTotal, total, briefTotal === total ? "PASS" : "WARN");

    const [runs] = await sql<{ failed: number; running: number }[]>`
      select count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'running')::int as running
      from public.import_runs
    `;
    record("ALL", "import runs still running", 0, runs.running);
    record("ALL", "failed import runs (history)", 0, runs.failed, runs.failed === 0 ? "PASS" : "WARN");
  } finally {
    await sql.end({ timeout: 5 });
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const icon = c.level === "PASS" ? "✓" : c.level === "FAIL" ? "✗" : c.level === "WARN" ? "!" : "·";
    const detail = c.level === "PASS" ? c.actual : `expected ${c.expected}, got ${c.actual}`;
    console.log(`${icon} ${c.level.padEnd(4)} ${c.scope.padEnd(12)} ${c.name.padEnd(width)}  ${detail.length > 160 ? detail.slice(0, 157) + "…" : detail}`);
  }
  const failed = checks.filter((c) => c.level === "FAIL").length;
  const warned = checks.filter((c) => c.level === "WARN").length;
  console.log(`\n${checks.length} checks: ${checks.length - failed - warned} passed, ${warned} warnings, ${failed} failed.`);
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Validation aborted: ${(err as Error).message}`);
    process.exit(1);
  });
