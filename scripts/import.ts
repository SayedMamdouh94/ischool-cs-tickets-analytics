/**
 * CS Tickets Analytics — CSV importer (admin CLI).
 *
 *   npm run db:import                       # import every *.csv in data/raw
 *   npm run db:import -- --file "<path>"    # import specific file(s)
 *   npm run db:import -- --dry-run          # parse + validate only, no writes
 *   npm run db:import -- --force-update     # apply rows even from older exports
 *   npm run db:import -- --skip-known-files # skip files already imported cleanly (same SHA-256)
 *
 * Transport (see scripts/lib/db.ts): a direct connection when DATABASE_URL is
 * set, otherwise the passwordless Supabase CLI / Management API transport.
 * Idempotent: re-running the same files inserts nothing and updates nothing.
 * Message contents are never printed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { IMPORTER_VERSION, UPDATE_POLICY } from "@/lib/ingest/columns";
import { DEFAULT_PROJECTS } from "@/lib/ingest/default-projects";
import { CsvStructureError, ProjectMappingError, processFile, sha256, type ProcessedFile, type ProjectRef } from "@/lib/ingest/file";
import type { RowError, TransformedRow } from "@/lib/ingest/transform";
import { CLI_MAX_SQL_BYTES, connectDb, jsonLiteral, sqlLiteral, withRetry, type Db } from "./lib/db";
import { classificationRows, classificationStatements, loadCategoryCatalog, type CategoryCatalog } from "./lib/classify-db";
import { optionalEnv } from "./lib/env";

const IMPORT_LOCK_KEY = "cs-tickets-analytics:import";

/** Columns written from a source row; jsonb_to_recordset column definitions. */
const TICKET_COLUMNS: [string, string][] = [
  ["ticket_id", "bigint"],
  ["project_id", "uuid"],
  ["organization_id", "int"],
  ["topic", "text"],
  ["message", "text"],
  ["status", "text"],
  ["priority", "text"],
  ["department", "text"],
  ["owner_type", "text"],
  ["owner_id", "text"],
  ["affected_student_id", "text"],
  ["created_at", "timestamptz"],
  ["responded_at", "timestamptz"],
  ["resolved_at", "timestamptz"],
  ["response", "text"],
  ["note", "text"],
  ["responder_name", "text"],
  ["resolved_by", "text"],
  ["attachment_urls", "text"],
  ["response_attachment_urls", "text"],
  ["sub_topic", "text"],
  ["session_ref", "text"],
  ["lesson_name", "text"],
  ["message_language", "text"],
  ["parser_version", "text"],
  ["source_filename", "text"],
  ["source_row_number", "int"],
  ["source_data_as_of", "timestamptz"],
  ["row_hash", "text"],
  ["first_import_run_id", "uuid"],
  ["last_import_run_id", "uuid"],
];
const COLS = TICKET_COLUMNS.map(([c]) => c).join(", ");
const RECORDSET = TICKET_COLUMNS.map(([c, t]) => `${c} ${t}`).join(", ");
/** first_import_run_id and imported_at are preserved on update; the (project, ticket) key never changes. */
const UPDATE_SET = TICKET_COLUMNS.filter(([c]) => c !== "ticket_id" && c !== "project_id" && c !== "organization_id" && c !== "first_import_run_id")
  .map(([c]) => `${c} = excluded.${c}`)
  .join(", ");

interface Counts {
  inserted: number;
  updated: number;
  unchanged: number;
  stale: number;
  rejected: number;
}

interface FileOutcome {
  file: string;
  project: string;
  status: "completed" | "completed_with_errors" | "failed" | "dry-run" | "skipped (already imported)";
  records: number;
  counts: Counts;
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCli() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string", default: "data/raw" },
      file: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
      "force-update": { type: "boolean", default: false },
      "skip-known-files": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  return values;
}

function discoverFiles(dir: string, explicit: string[] | undefined): string[] {
  if (explicit && explicit.length > 0) return explicit.map((f) => path.resolve(f));
  const full = path.resolve(dir);
  let entries: string[];
  try {
    entries = readdirSync(full);
  } catch {
    throw new Error(`Directory not found: ${dir}. Place the CSV exports in data/raw/.`);
  }
  return entries
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .sort()
    .map((f) => path.join(full, f));
}

/** Reconstructs a raw-row payload for errors detected after transformation. */
function rawFromRecord(row: TransformedRow): RowError["raw"] {
  const r = row.record;
  return {
    Ticket_ID: String(r.ticket_id),
    Topic: r.topic,
    Message: r.message ?? "",
    Status: r.status ?? "",
    Priority: r.priority ?? "",
    Department: r.department ?? "",
    Owner_Type: r.owner_type ?? "",
    Owner_ID: r.owner_id ?? "",
    Affected_Student_ID: r.affected_student_id ?? "",
    Created_At: r.created_at,
    Responded_At: r.responded_at ?? "",
    Resolved_At: r.resolved_at ?? "",
    Response: r.response ?? "",
    Note: r.note ?? "",
    Responder_Name: r.responder_name ?? "",
    Resolved_By: r.resolved_by ?? "",
    Organization_ID: String(r.organization_id),
    Attachment_URLs: r.attachment_urls ?? "",
    Response_Attachment_URLs: r.response_attachment_urls ?? "",
  };
}

function errorRow(runId: string, e: RowError) {
  return {
    import_run_id: runId,
    source_row_number: e.rowNumber,
    ticket_id: e.ticketId,
    error_code: e.code,
    validation_error: e.line > 0 ? `line ${e.line}: ${e.message}` : e.message,
    raw_row: e.raw,
  };
}

function errorInsertStatement(rows: ReturnType<typeof errorRow>[]): string {
  if (rows.length === 0) return "";
  return `
insert into public.import_errors (import_run_id, source_row_number, ticket_id, error_code, validation_error, raw_row)
select import_run_id, source_row_number, ticket_id, error_code, validation_error, raw_row
  from jsonb_to_recordset(${jsonLiteral(rows)}) as e(import_run_id uuid, source_row_number int, ticket_id bigint, error_code text, validation_error text, raw_row jsonb);
`;
}

/** Splits items into chunks whose JSON stays under a byte budget. */
function chunkBySize<T>(items: T[], maxBytes: number, maxItems: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const s = Buffer.byteLength(JSON.stringify(item));
    if (current.length > 0 && (size + s > maxBytes || current.length >= maxItems)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += s;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function insertErrors(db: Db, rows: ReturnType<typeof errorRow>[]): Promise<void> {
  for (const chunk of chunkBySize(rows, CLI_MAX_SQL_BYTES * 0.6, 500)) {
    await withRetry("insert import_errors", () => db.script(errorInsertStatement(chunk)));
  }
}

interface Existing {
  project_id: string;
  row_hash: string;
  as_of_epoch: number;
}

/**
 * Existing tickets with these source IDs in the target project, plus — to
 * detect exports filed under the wrong project — in the other active (or
 * draft) projects of the same reporting cycle. IDs in archived projects or
 * other cycles are independent datasets and do not collide.
 */
async function prefetchExisting(db: Db, projectId: string, ids: number[]): Promise<Map<number, Existing[]>> {
  const out = new Map<number, Existing[]>();
  for (let i = 0; i < ids.length; i += 4000) {
    const chunk = ids.slice(i, i + 4000);
    const rows = await withRetry("prefetch existing tickets", () =>
      db.query<{ ticket_id: number; project_id: string; row_hash: string; as_of_epoch: number }>(
        `select t.ticket_id::bigint as ticket_id, t.project_id::text as project_id, t.row_hash,
                extract(epoch from t.source_data_as_of)::float8 as as_of_epoch
           from public.tickets t
           join public.projects p on p.id = t.project_id
          where t.ticket_id in (select (jsonb_array_elements_text($1::jsonb))::bigint)
            and (t.project_id = $2::uuid
                 or (p.status in ('active', 'draft') and p.cycle_id = (select cycle_id from public.projects where id = $2::uuid)))`,
        [chunk, projectId],
      ),
    );
    for (const r of rows) {
      const list = out.get(Number(r.ticket_id)) ?? [];
      list.push({ project_id: r.project_id, row_hash: r.row_hash, as_of_epoch: Number(r.as_of_epoch) });
      out.set(Number(r.ticket_id), list);
    }
  }
  return out;
}

/**
 * One atomic write for a batch: upsert tickets (guarded so a ticket can never
 * move between projects and older exports never overwrite newer data), then
 * replace attachments and classifications ONLY for tickets that now hold
 * exactly the incoming source row.
 */
function batchScript(projectId: string, rows: TransformedRow[], records: Record<string, unknown>[], catalog: CategoryCatalog, forceUpdate: boolean): string {
  const pid = sqlLiteral(projectId);
  const keys = rows.map((r) => ({ ticket_id: r.record.ticket_id, row_hash: r.record.row_hash }));
  const attachments = rows.flatMap((r) =>
    r.attachments.map((a) => ({
      ticket_id: r.record.ticket_id,
      row_hash: r.record.row_hash,
      attachment_type: a.attachmentType,
      position: a.position,
      url: a.url,
      url_host: a.host,
      file_name: a.fileName,
      file_extension: a.extension,
    })),
  );
  const classifications = classificationRows(
    catalog,
    rows.map((r) => ({ ticketId: r.record.ticket_id, topic: r.record.topic, details: r.details, rowHash: r.record.row_hash })),
  );
  return `
insert into public.tickets (${COLS})
select ${COLS} from jsonb_to_recordset(${jsonLiteral(records)}) as r(${RECORDSET})
on conflict (project_id, ticket_id) do update set ${UPDATE_SET}, updated_at = now()
where public.tickets.row_hash is distinct from excluded.row_hash
  ${forceUpdate ? "" : "and excluded.source_data_as_of >= public.tickets.source_data_as_of"};

delete from public.ticket_attachments a
 using jsonb_to_recordset(${jsonLiteral(keys)}) as k(ticket_id bigint, row_hash text), public.tickets t
 where t.project_id = ${pid}::uuid and t.ticket_id = k.ticket_id and t.row_hash = k.row_hash and a.ticket_pk = t.id;
${
  attachments.length === 0
    ? ""
    : `
insert into public.ticket_attachments (ticket_pk, attachment_type, position, url, url_host, file_name, file_extension)
select t.id, x.attachment_type, x.position, x.url, x.url_host, x.file_name, x.file_extension
  from jsonb_to_recordset(${jsonLiteral(attachments)}) as x(ticket_id bigint, row_hash text, attachment_type text, position smallint, url text, url_host text, file_name text, file_extension text)
  join public.tickets t on t.project_id = ${pid}::uuid and t.ticket_id = x.ticket_id and t.row_hash = x.row_hash;
`
}
${classificationStatements(classifications, { projectId })}
`;
}

function pad(value: string | number, width: number): string {
  const s = String(value);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function printSummary(outcomes: FileOutcome[]): void {
  console.log("\nImport summary");
  console.log(`${pad("File", 40)} ${pad("Project", 12)} ${pad("Rows", 6)} ${pad("Ins", 6)} ${pad("Upd", 6)} ${pad("Same", 6)} ${pad("Stale", 6)} ${pad("Rej", 5)} Status`);
  for (const o of outcomes) {
    console.log(
      `${pad(o.file.slice(0, 39), 40)} ${pad(o.project, 12)} ${pad(o.records, 6)} ${pad(o.counts.inserted, 6)} ${pad(o.counts.updated, 6)} ${pad(o.counts.unchanged, 6)} ${pad(o.counts.stale, 6)} ${pad(o.counts.rejected, 5)} ${o.status}${o.error ? ` — ${o.error}` : ""}`,
    );
  }
  const t = outcomes.reduce(
    (a, o) => ({ r: a.r + o.records, i: a.i + o.counts.inserted, u: a.u + o.counts.updated, s: a.s + o.counts.unchanged, st: a.st + o.counts.stale, rj: a.rj + o.counts.rejected }),
    { r: 0, i: 0, u: 0, s: 0, st: 0, rj: 0 },
  );
  console.log(`${pad("TOTAL", 40)} ${pad("", 12)} ${pad(t.r, 6)} ${pad(t.i, 6)} ${pad(t.u, 6)} ${pad(t.s, 6)} ${pad(t.st, 6)} ${pad(t.rj, 5)}`);
}

async function dryRun(files: string[]): Promise<number> {
  let projects: ProjectRef[] = DEFAULT_PROJECTS;
  let source = "built-in project list (offline)";
  if (optionalEnv("DATABASE_URL") || optionalEnv("DB_TRANSPORT") || optionalEnv("NEXT_PUBLIC_SUPABASE_URL")?.includes(".supabase.co")) {
    const db = connectDb();
    try {
      projects = await db.query<ProjectRef>(
        "select id::text as id, code, name, organization_id::int as organization_id, file_name_hint from public.projects where status = 'active'",
      );
      source = `database (${db.target})`;
    } finally {
      await db.end();
    }
  }
  console.log(`Dry run — no data will be written. Projects from: ${source}\n`);
  const outcomes: FileOutcome[] = [];
  for (const f of files) {
    const name = path.basename(f);
    try {
      const pf = processFile(name, readFileSync(f), projects);
      outcomes.push({ file: name, project: pf.project.code, status: "dry-run", records: pf.stats.records_in_file, counts: { inserted: pf.rows.length, updated: 0, unchanged: 0, stale: 0, rejected: pf.errors.length } });
      for (const e of pf.errors.slice(0, 20)) console.log(`  ✗ ${name} row ${e.rowNumber} (line ${e.line}) ${e.code}: ${e.message}`);
    } catch (err) {
      outcomes.push({ file: name, project: "-", status: "failed", records: 0, counts: { inserted: 0, updated: 0, unchanged: 0, stale: 0, rejected: 0 }, error: (err as Error).message });
    }
  }
  printSummary(outcomes);
  console.log("\n(Dry run: 'Ins' = valid rows that would be considered for insert/update.)");
  return outcomes.some((o) => o.status === "failed") ? 1 : 0;
}

async function main(): Promise<number> {
  const args = parseCli();
  if (args.help) {
    console.log("Usage: npm run db:import -- [--dir data/raw] [--file <csv> ...] [--dry-run] [--force-update]");
    return 0;
  }
  const files = discoverFiles(args.dir!, args.file);
  if (files.length === 0) {
    console.error("No CSV files found. Place the ticket exports in data/raw/ and re-run.");
    return 1;
  }
  if (args["dry-run"]) return dryRun(files);

  const forceUpdate = Boolean(args["force-update"]);
  const db = connectDb();
  console.log(`Importing ${files.length} file(s) into ${db.target} [${db.kind}]`);
  const outcomes: FileOutcome[] = [];
  let locked = false;

  try {
    // Concurrency guard. The postgres transport also takes a session lock; the
    // HTTP transport relies on the import_runs table.
    if (db.kind === "postgres") {
      const [{ ok }] = await db.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1)) as ok", [IMPORT_LOCK_KEY]);
      if (!ok) {
        console.error("Another import is running (advisory lock held). Aborting.");
        return 1;
      }
      locked = true;
    }
    const [web] = await db.query<{ n: number }>("select count(*)::int as n from public.import_jobs where status = 'importing'");
    if (Number(web?.n ?? 0) > 0) {
      console.error("A web import is running (Settings & Imports). Wait until it completes, then run the CLI importer.");
      return 1;
    }
    const active = await db.query<{ n: number }>(
      "select count(*)::int as n from public.import_runs where status = 'running' and source = 'cli' and started_at > now() - interval '2 hours'",
    );
    if (Number(active[0]?.n ?? 0) > 0 && db.kind !== "postgres") {
      console.error("An import started less than 2 hours ago is still marked running. Aborting to avoid concurrent imports.");
      return 1;
    }
    const abandoned = await db.query<{ id: string }>(
      `update public.import_runs set status = 'failed', completed_at = now(),
              error_summary = coalesce(error_summary, 'Abandoned: the importer stopped before completing this run.')
        where status = 'running' and source = 'cli' returning id::text as id`,
    );
    if (abandoned.length > 0) console.warn(`Marked ${abandoned.length} abandoned run(s) as failed.`);

    // Only active projects receive imports (archived ones are read-only; drafts belong to a web job).
    const projects = await db.query<ProjectRef>(
      "select id::text as id, code, name, organization_id::int as organization_id, file_name_hint from public.projects where status = 'active'",
    );
    const catalog = await loadCategoryCatalog(db);
    const seenInRun = new Map<number, { projectId: string; file: string }>();

    for (const f of files) {
      const name = path.basename(f);
      const buffer = readFileSync(f);
      const size = statSync(f).size;
      const fileHash = sha256(buffer);
      const counts: Counts = { inserted: 0, updated: 0, unchanged: 0, stale: 0, rejected: 0 };

      const [prior] = await db.query<{ id: string; clean: boolean; records: number }>(
        `select id::text as id, (status = 'completed' and rejected_count = 0) as clean, coalesce(records_in_file, 0)::int as records
           from public.import_runs where file_hash = $1 and status in ('completed', 'completed_with_errors')
          order by completed_at desc limit 1`,
        [fileHash],
      );
      if (prior?.clean && args["skip-known-files"]) {
        console.log(`\n▷ ${name}: identical file already imported cleanly (run ${prior.id}) — skipped. db:validate verifies its rows.`);
        outcomes.push({ file: name, project: "-", status: "skipped (already imported)", records: Number(prior.records), counts: { ...counts, unchanged: Number(prior.records) } });
        continue;
      }
      const [run] = await db.query<{ id: string }>(
        `insert into public.import_runs (source_filename, file_hash, file_size_bytes, update_policy, importer_version, duplicate_of_run_id)
         values ($1, $2, $3::bigint, $4, $5, $6::uuid) returning id::text as id`,
        [name, fileHash, size, UPDATE_POLICY, IMPORTER_VERSION, prior?.id ?? null],
      );
      const runId = run.id;
      if (!UUID.test(runId)) throw new Error("Unexpected import run id.");
      console.log(`\n▶ ${name} (${(size / 1024 / 1024).toFixed(2)} MB, sha256 ${fileHash.slice(0, 12)}…)${prior ? " — identical file imported before; verifying idempotently" : ""}`);

      let pf: ProcessedFile;
      try {
        pf = processFile(name, buffer, projects);
      } catch (err) {
        const code = err instanceof CsvStructureError ? "FILE_STRUCTURE_INVALID" : err instanceof ProjectMappingError ? "PROJECT_MAPPING_FAILED" : "FILE_PROCESSING_FAILED";
        const message = (err as Error).message;
        await db.query("insert into public.import_errors (import_run_id, error_code, validation_error) values ($1::uuid, $2, $3)", [runId, code, message]);
        await db.query("update public.import_runs set status = 'failed', completed_at = now(), error_summary = $2 where id = $1::uuid", [runId, `${code}: ${message}`]);
        console.error(`  ✗ ${code}: ${message}`);
        outcomes.push({ file: name, project: "-", status: "failed", records: 0, counts, error: code });
        continue;
      }

      await db.query(
        `update public.import_runs set project_id = $2::uuid, records_in_file = $3::int, data_as_of = $4::timestamptz,
                min_created_at = $5::timestamptz, max_created_at = $6::timestamptz where id = $1::uuid`,
        [runId, pf.project.id, pf.stats.records_in_file, pf.stats.data_as_of, pf.stats.min_created_at, pf.stats.max_created_at],
      );
      console.log(`  project ${pf.project.code}; ${pf.stats.records_in_file} records; ${pf.errors.length} invalid; data as of ${pf.stats.data_as_of}`);

      let committed = 0;
      let pending = 0;
      try {
        if (pf.errors.length > 0) {
          await insertErrors(db, pf.errors.map((e) => errorRow(runId, e)));
          counts.rejected += pf.errors.length;
        }

        // Duplicates across files within this same run.
        const rows: TransformedRow[] = [];
        const preErrors: RowError[] = [];
        for (const row of pf.rows) {
          const seen = seenInRun.get(row.record.ticket_id);
          if (seen) {
            preErrors.push({
              rowNumber: row.record.source_row_number,
              line: 0,
              ticketId: row.record.ticket_id,
              code: seen.projectId === pf.project.id ? "DUPLICATE_TICKET_ACROSS_FILES" : "TICKET_ID_COLLISION",
              message: `Ticket ${row.record.ticket_id} was already imported from ${seen.file} in this run.`,
              raw: rawFromRecord(row),
            });
          } else {
            seenInRun.set(row.record.ticket_id, { projectId: pf.project.id, file: name });
            rows.push(row);
          }
        }

        // Classify every row against the database (same policy as before).
        const existing = await prefetchExisting(db, pf.project.id, rows.map((r) => r.record.ticket_id));
        const dataAsOf = Date.parse(pf.stats.data_as_of!) / 1000;
        const toWrite: TransformedRow[] = [];
        for (const row of rows) {
          const found = existing.get(row.record.ticket_id) ?? [];
          const prev = found.find((e) => e.project_id === pf.project.id);
          const other = found.find((e) => e.project_id !== pf.project.id);
          if (other) {
            preErrors.push({
              rowNumber: row.record.source_row_number,
              line: 0,
              ticketId: row.record.ticket_id,
              code: "TICKET_ID_COLLISION",
              message: `Ticket ${row.record.ticket_id} already exists in another project of this reporting cycle (${other.project_id}); refusing to import it into ${pf.project.code}.`,
              raw: rawFromRecord(row),
            });
          } else if (!prev) {
            toWrite.push(row);
            counts.inserted++;
          } else if (prev.row_hash === row.record.row_hash) {
            counts.unchanged++;
          } else if (!forceUpdate && dataAsOf < prev.as_of_epoch) {
            counts.stale++;
          } else {
            toWrite.push(row);
            counts.updated++;
          }
        }
        if (preErrors.length > 0) {
          await insertErrors(db, preErrors.map((e) => errorRow(runId, e)));
          counts.rejected += preErrors.length;
        }

        const records = new Map(
          toWrite.map((r) => [
            r.record.ticket_id,
            {
              ...r.record,
              project_id: pf.project.id,
              source_filename: pf.fileName,
              source_data_as_of: pf.stats.data_as_of,
              first_import_run_id: runId,
              last_import_run_id: runId,
            } as Record<string, unknown>,
          ]),
        );
        const batches = chunkBySize(toWrite, CLI_MAX_SQL_BYTES * 0.45, 500);
        pending = toWrite.length;
        for (const batch of batches) {
          const script = batchScript(pf.project.id, batch, batch.map((r) => records.get(r.record.ticket_id)!), catalog, forceUpdate);
          await withRetry(`batch @row ${batch[0].record.source_row_number}`, () => db.script(script));
          committed += batch.length;
          if (process.stdout.isTTY) process.stdout.write(`  … ${committed}/${toWrite.length}\r`);
        }

        const status = counts.rejected > 0 ? "completed_with_errors" : "completed";
        await db.query(
          `update public.import_runs
              set status = $2, completed_at = now(), inserted_count = $3::int, updated_count = $4::int,
                  skipped_unchanged_count = $5::int, skipped_stale_count = $6::int, rejected_count = $7::int,
                  reconciliation = $8::jsonb, error_summary = $9
            where id = $1::uuid`,
          [
            runId,
            status,
            counts.inserted,
            counts.updated,
            counts.unchanged,
            counts.stale,
            counts.rejected,
            { ...pf.stats, classification_version: "rules-v1", transport: db.kind },
            counts.rejected > 0 ? `${counts.rejected} row(s) rejected; see import_errors.` : null,
          ],
        );
        const [{ n }] = await db.query<{ n: number }>("select count(*)::int as n from public.tickets where project_id = $1::uuid", [pf.project.id]);
        console.log(
          `  ✓ ${status}: +${counts.inserted} inserted, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.stale} stale, ${counts.rejected} rejected — project now has ${n} tickets (${batches.length} write batch(es))`,
        );
        outcomes.push({ file: name, project: pf.project.code, status, records: pf.stats.records_in_file, counts });
      } catch (err) {
        const message = (err as Error).message;
        await db
          .query(
            `update public.import_runs set status = 'failed', completed_at = now(), inserted_count = 0, updated_count = 0,
                    skipped_unchanged_count = 0, skipped_stale_count = 0, rejected_count = 0, error_summary = $2
              where id = $1::uuid`,
            [runId, `${message.slice(0, 1800)} (committed ${committed} of ${pending} rows before failing; each batch is atomic — re-run to resume)`],
          )
          .catch(() => {});
        console.error(`  ✗ failed: ${message}`);
        outcomes.push({ file: name, project: pf.project.code, status: "failed", records: pf.stats.records_in_file, counts, error: message.slice(0, 120) });
      }
    }
  } finally {
    if (locked) await db.query("select pg_advisory_unlock(hashtext($1))", [IMPORT_LOCK_KEY]).catch(() => {});
    await db.end();
  }

  printSummary(outcomes);
  console.log("\nNext: run `npm run db:validate` to reconcile the database against the source files.");
  return outcomes.some((o) => o.status === "failed") ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Import aborted: ${(err as Error).message}`);
    process.exit(1);
  });
