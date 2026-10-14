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
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { SOURCE_COLUMNS, type SourceColumn } from "@/lib/ingest/columns";
import { BRIEF_EXPECTED_COUNTS } from "@/lib/ingest/default-projects";
import { processFile, type ProcessedFile, type ProjectRef } from "@/lib/ingest/file";
import { median, percentileCont } from "@/lib/analytics/stats";
import { connectDb, type Db } from "./lib/db";

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

/** Fields whose stored value must equal the (normalized) source value exactly. */
const FIDELITY_FIELDS = [
  "topic",
  "message",
  "response",
  "note",
  "status",
  "department",
  "owner_type",
  "owner_id",
  "responder_name",
  "resolved_by",
  "attachment_urls",
  "response_attachment_urls",
] as const;
const NULL_MARK = "<NULL>";

const MISSING_SQL = SOURCE_COLUMNS.map((col) => {
  const dbCol = DB_COLUMN[col];
  return `'${col}', ${dbCol === null ? "0" : `count(*) filter (where ${dbCol} is null)::int`}`;
}).join(",\n      ");

async function validateFile(db: Db, pf: ProcessedFile): Promise<void> {
  const scope = pf.project.code;
  const pid = pf.project.id;

  record(scope, "file records = accepted + rejected", pf.stats.records_in_file, pf.stats.accepted + pf.stats.rejected);
  if (pf.errors.length > 0) {
    record(scope, "rows rejected by validation", 0, pf.errors.length, "WARN");
  }

  const dbRows = await db.query<{ ticket_id: number; row_hash: string }>(
    "select ticket_id::bigint as ticket_id, row_hash from public.tickets where project_id = $1::uuid",
    [pid],
  );
  const dbById = new Map(dbRows.map((r) => [Number(r.ticket_id), r]));
  let missing = 0;
  let hashMismatch = 0;
  for (const row of pf.rows) {
    const found = dbById.get(row.record.ticket_id);
    if (!found) missing++;
    else if (found.row_hash !== row.record.row_hash) hashMismatch++;
  }
  const fileIds = new Set(pf.rows.map((r) => r.record.ticket_id));
  const extra = dbRows.filter((r) => !fileIds.has(Number(r.ticket_id))).length;

  record(scope, "tickets in database", pf.stats.accepted, dbRows.length);
  record(scope, "file tickets missing from database", 0, missing);
  record(scope, "row content hash mismatches", 0, hashMismatch);
  record(scope, "database tickets not in this file", 0, extra, extra === 0 ? "PASS" : "WARN");

  // All per-project statistics in one round trip (efficient over the HTTP transport).
  const [st] = await db.query<{
    status: Record<string, number> | null;
    missing: Record<string, number>;
    anomalies: Record<string, number>;
    rn: number;
    rmed: number | null;
    rp90: number | null;
    sn: number;
    smed: number | null;
    sp90: number | null;
    att_req: number;
    att_resp: number;
    classified: number;
  }>(
    `with t as (select * from public.tickets where project_id = $1::uuid)
     select
       (select jsonb_object_agg(k, n) from (select coalesce(status, '__none__') as k, count(*)::int as n from t group by 1) s) as status,
       (select jsonb_build_object(
      ${MISSING_SQL}) from t) as missing,
       (select jsonb_build_object(
          'resolved_before_responded', count(*) filter (where resolved_at < responded_at)::int,
          'responded_before_created', count(*) filter (where responded_at < created_at)::int,
          'resolved_before_created', count(*) filter (where resolved_at < created_at)::int,
          'completed_without_resolved_at', count(*) filter (where status = 'completed' and resolved_at is null)::int,
          'pending_with_resolved_at', count(*) filter (where status = 'pending' and resolved_at is not null)::int,
          'responded_equals_resolved', count(*) filter (where responded_at = resolved_at)::int) from t) as anomalies,
       (select count(*) filter (where response_seconds >= 0)::int from t) as rn,
       (select round((percentile_cont(0.5) within group (order by response_seconds) filter (where response_seconds >= 0))::numeric)::float8 from t) as rmed,
       (select round((percentile_cont(0.9) within group (order by response_seconds) filter (where response_seconds >= 0))::numeric)::float8 from t) as rp90,
       (select count(*) filter (where resolution_seconds >= 0)::int from t) as sn,
       (select round((percentile_cont(0.5) within group (order by resolution_seconds) filter (where resolution_seconds >= 0))::numeric)::float8 from t) as smed,
       (select round((percentile_cont(0.9) within group (order by resolution_seconds) filter (where resolution_seconds >= 0))::numeric)::float8 from t) as sp90,
       (select count(*)::int from public.ticket_attachments a join t on t.ticket_id = a.ticket_id where a.attachment_type = 'request') as att_req,
       (select count(*)::int from public.ticket_attachments a join t on t.ticket_id = a.ticket_id where a.attachment_type = 'response') as att_resp,
       (select count(*)::int from public.ticket_classifications c join t on t.ticket_id = c.ticket_id where c.is_current) as classified`,
    [pid],
  );

  record(scope, "status counts", sortedObject(pf.stats.status_counts), sortedObject(st.status ?? {}));
  const fileMissing: Record<string, number> = {};
  const dbMissing: Record<string, number> = {};
  for (const col of SOURCE_COLUMNS) {
    fileMissing[col] = pf.stats.missing[col];
    dbMissing[col] = Number(st.missing[col]);
  }
  record(scope, "missing values per field", fileMissing, dbMissing);
  record(scope, "timestamp anomalies", sortedObject(pf.stats.anomalies), sortedObject(st.anomalies));

  // Durations: recompute from the file in TypeScript, compare with SQL.
  const resp = pf.rows.filter((r) => r.respondedEpochMs !== null).map((r) => (r.respondedEpochMs! - r.createdEpochMs) / 1000).filter((x) => x >= 0);
  const reso = pf.rows.filter((r) => r.resolvedEpochMs !== null).map((r) => (r.resolvedEpochMs! - r.createdEpochMs) / 1000).filter((x) => x >= 0);
  const num = (v: number | null) => (v === null ? null : Number(v));
  record(scope, "recorded response duration (n, median s, p90 s)", [resp.length, round(median(resp)), round(percentileCont(resp, 0.9))], [Number(st.rn), num(st.rmed), num(st.rp90)]);
  record(scope, "resolution duration (n, median s, p90 s)", [reso.length, round(median(reso)), round(percentileCont(reso, 0.9))], [Number(st.sn), num(st.smed), num(st.sp90)]);
  record(scope, "attachment references (request, response)", [pf.stats.attachments.request, pf.stats.attachments.response], [Number(st.att_req), Number(st.att_resp)]);
  record(scope, "current classifications", pf.stats.accepted, Number(st.classified));
  record(scope, "timestamp offsets inconsistent with Africa/Cairo", 0, pf.stats.offset_mismatches_vs_cairo, pf.stats.offset_mismatches_vs_cairo === 0 ? "PASS" : "WARN");

  // Fidelity: re-read the STORED values (not the importer's hash) and compare
  // every free-text/identifier field and every timestamp with the source file.
  const stored = await db.query<{ id: number; h: string; c: number | null; r: number | null; s: number | null }>(
    `select ticket_id::bigint as id,
            md5(${FIDELITY_FIELDS.map((f) => `coalesce(${f}, '${NULL_MARK}')`).join(" || chr(31) || ")}) as h,
            extract(epoch from created_at)::bigint as c,
            extract(epoch from responded_at)::bigint as r,
            extract(epoch from resolved_at)::bigint as s
       from public.tickets where project_id = $1::uuid`,
    [pid],
  );
  const storedById = new Map(stored.map((x) => [Number(x.id), x]));
  let textMismatch = 0;
  let timeMismatch = 0;
  const sec = (ms: number | null) => (ms === null ? null : Math.round(ms / 1000));
  for (const row of pf.rows) {
    const db_ = storedById.get(row.record.ticket_id);
    if (!db_) continue;
    const rec = row.record as unknown as Record<string, string | null>;
    const digest = createHash("md5")
      .update(FIDELITY_FIELDS.map((f) => rec[f] ?? NULL_MARK).join("\u001f"), "utf8")
      .digest("hex");
    if (digest !== db_.h) textMismatch++;
    const asNum = (v: number | null) => (v === null ? null : Number(v));
    if (asNum(db_.c) !== sec(row.createdEpochMs) || asNum(db_.r) !== sec(row.respondedEpochMs) || asNum(db_.s) !== sec(row.resolvedEpochMs)) timeMismatch++;
  }
  record(scope, "stored text fields identical to source (md5)", 0, textMismatch);
  record(scope, "stored timestamps identical to source", 0, timeMismatch);

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

  const db = connectDb();
  console.log(`Validating ${files.length} file(s) against ${db.target} [${db.kind}]\n`);
  try {
    const projects = await db.query<ProjectRef>(
      "select id::text as id, code, name, organization_id::int as organization_id, file_name_hint from public.projects",
    );
    let fileTotal = 0;
    const allIds = new Set<number>();
    for (const f of files) {
      const pf = processFile(f, readFileSync(path.join(dir, f)), projects);
      fileTotal += pf.stats.accepted;
      for (const r of pf.rows) allIds.add(r.record.ticket_id);
      await validateFile(db, pf);
    }
    const [{ total, distinct_ids }] = await db.query<{ total: number; distinct_ids: number }>(
      "select count(*)::int as total, count(distinct ticket_id)::int as distinct_ids from public.tickets",
    );
    record("ALL", "total tickets (files vs database)", fileTotal, total);
    record("ALL", "unique ticket IDs across files", fileTotal, allIds.size);
    record("ALL", "unique ticket IDs in database", total, distinct_ids);
    const briefTotal = Object.values(BRIEF_EXPECTED_COUNTS).reduce((a, b) => a + b, 0);
    record("ALL", "total vs. project brief (initial export)", briefTotal, total, briefTotal === total ? "PASS" : "WARN");

    const [runs] = await db.query<{ failed: number; running: number }>(
      "select count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'running')::int as running from public.import_runs",
    );
    record("ALL", "import runs still running", 0, runs.running);
    record("ALL", "failed import runs (history)", 0, runs.failed, runs.failed === 0 ? "PASS" : "WARN");
  } finally {
    await db.end();
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
