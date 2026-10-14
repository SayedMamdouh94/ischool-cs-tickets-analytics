/**
 * CS Tickets Analytics — CSV importer (admin CLI).
 *
 *   npm run db:import                       # import every *.csv in data/raw
 *   npm run db:import -- --file "<path>"    # import specific file(s)
 *   npm run db:import -- --dry-run          # parse + validate only, no writes
 *   npm run db:import -- --force-update     # apply rows even from older exports
 *
 * Idempotent: re-running the same files inserts nothing and updates nothing.
 * Message contents are never printed to the console.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { IMPORTER_VERSION, UPDATE_POLICY } from "@/lib/ingest/columns";
import { DEFAULT_PROJECTS } from "@/lib/ingest/default-projects";
import { CsvStructureError, ProjectMappingError, processFile, sha256, type ProcessedFile, type ProjectRef } from "@/lib/ingest/file";
import type { RowError, TransformedRow } from "@/lib/ingest/transform";
import { IMPORT_LOCK_KEY, connect, withRetry, type Sql } from "./lib/db";
import { loadCategoryCatalog, writeClassifications, type CategoryCatalog } from "./lib/classify-db";
import { optionalEnv } from "./lib/env";

const TICKET_COLUMNS = [
  "ticket_id",
  "project_id",
  "organization_id",
  "topic",
  "message",
  "status",
  "priority",
  "department",
  "owner_type",
  "owner_id",
  "affected_student_id",
  "created_at",
  "responded_at",
  "resolved_at",
  "response",
  "note",
  "responder_name",
  "resolved_by",
  "attachment_urls",
  "response_attachment_urls",
  "sub_topic",
  "session_ref",
  "lesson_name",
  "message_language",
  "parser_version",
  "source_filename",
  "source_row_number",
  "source_data_as_of",
  "row_hash",
  "first_import_run_id",
  "last_import_run_id",
] as const;

/** Columns refreshed on update. first_import_run_id / imported_at are preserved. */
const UPDATE_COLUMNS = TICKET_COLUMNS.filter((c) => !["ticket_id", "first_import_run_id"].includes(c));
const UPDATE_SET = UPDATE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");

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
  status: "completed" | "completed_with_errors" | "failed" | "dry-run";
  records: number;
  counts: Counts;
  error?: string;
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string", default: "data/raw" },
      file: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
      "force-update": { type: "boolean", default: false },
      "batch-size": { type: "string", default: "500" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  return values;
}

function discoverFiles(dir: string, explicit: string[] | undefined): string[] {
  if (explicit && explicit.length > 0) {
    return explicit.map((f) => path.resolve(f));
  }
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

function errorRow(runId: string, e: RowError) {
  return {
    import_run_id: runId,
    source_row_number: e.rowNumber,
    ticket_id: e.ticketId,
    error_code: e.code,
    validation_error: `line ${e.line}: ${e.message}`,
    raw_row: e.raw,
  };
}

async function insertErrors(sql: Sql, rows: ReturnType<typeof errorRow>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await withRetry("insert import_errors", () =>
      sql`insert into public.import_errors ${sql(chunk, "import_run_id", "source_row_number", "ticket_id", "error_code", "validation_error", "raw_row")}`,
    );
  }
}

async function processBatch(
  sql: Sql,
  catalog: CategoryCatalog,
  runId: string,
  file: ProcessedFile,
  batch: TransformedRow[],
  forceUpdate: boolean,
): Promise<Counts> {
  return withRetry(`batch @row ${batch[0].record.source_row_number}`, () =>
    sql.begin(async (tx) => {
      const counts: Counts = { inserted: 0, updated: 0, unchanged: 0, stale: 0, rejected: 0 };
      const ids = batch.map((r) => r.record.ticket_id);
      const existing = await tx<{ ticket_id: number; project_id: string; row_hash: string; source_data_as_of: Date }[]>`
        select ticket_id, project_id, row_hash, source_data_as_of
        from public.tickets
        where ticket_id = any(${ids}::bigint[])
      `;
      const byId = new Map(existing.map((e) => [Number(e.ticket_id), e]));
      const dataAsOf = new Date(file.stats.data_as_of!);

      const toWrite: TransformedRow[] = [];
      const writeKinds = new Map<number, "insert" | "update">();
      const collisions: RowError[] = [];

      for (const row of batch) {
        const prev = byId.get(row.record.ticket_id);
        if (!prev) {
          toWrite.push(row);
          writeKinds.set(row.record.ticket_id, "insert");
        } else if (prev.project_id !== file.project.id) {
          collisions.push({
            rowNumber: row.record.source_row_number,
            line: 0,
            ticketId: row.record.ticket_id,
            code: "TICKET_ID_COLLISION",
            message: `Ticket ${row.record.ticket_id} already exists in another project (${prev.project_id}); refusing to overwrite it from ${file.project.code}.`,
            raw: {} as RowError["raw"],
          });
        } else if (prev.row_hash === row.record.row_hash) {
          counts.unchanged++;
        } else if (!forceUpdate && dataAsOf.getTime() < new Date(prev.source_data_as_of).getTime()) {
          counts.stale++;
        } else {
          toWrite.push(row);
          writeKinds.set(row.record.ticket_id, "update");
        }
      }

      if (toWrite.length > 0) {
        const rows = toWrite.map((r) => ({
          ...r.record,
          project_id: file.project.id,
          source_filename: file.fileName,
          source_data_as_of: file.stats.data_as_of,
          first_import_run_id: runId,
          last_import_run_id: runId,
        }));
        await tx`
          insert into public.tickets ${tx(rows, ...TICKET_COLUMNS)}
          on conflict (ticket_id) do update set ${tx.unsafe(UPDATE_SET)}, updated_at = now()
          where public.tickets.project_id = excluded.project_id
        `;
        const changedIds = toWrite.map((r) => r.record.ticket_id);
        await tx`delete from public.ticket_attachments where ticket_id = any(${changedIds}::bigint[])`;
        const attachments = toWrite.flatMap((r) =>
          r.attachments.map((a) => ({
            ticket_id: r.record.ticket_id,
            attachment_type: a.attachmentType,
            position: a.position,
            url: a.url,
            url_host: a.host,
            file_name: a.fileName,
            file_extension: a.extension,
          })),
        );
        if (attachments.length > 0) {
          await tx`
            insert into public.ticket_attachments ${tx(attachments, "ticket_id", "attachment_type", "position", "url", "url_host", "file_name", "file_extension")}
          `;
        }
        await writeClassifications(
          tx,
          catalog,
          toWrite.map((r) => ({ ticketId: r.record.ticket_id, topic: r.record.topic, details: r.details })),
        );
        for (const kind of writeKinds.values()) {
          if (kind === "insert") counts.inserted++;
          else counts.updated++;
        }
      }

      if (collisions.length > 0) {
        // Keep the payload for investigation (admin-only table).
        const withRaw = collisions.map((c) => {
          const src = batch.find((b) => b.record.ticket_id === c.ticketId)!;
          return { ...c, raw: rawFromRecord(src) };
        });
        await tx`insert into public.import_errors ${tx(withRaw.map((c) => errorRow(runId, c)), "import_run_id", "source_row_number", "ticket_id", "error_code", "validation_error", "raw_row")}`;
        counts.rejected += collisions.length;
      }
      return counts;
    }),
  );
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

function pad(value: string | number, width: number): string {
  const s = String(value);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function printSummary(outcomes: FileOutcome[]): void {
  console.log("\nImport summary");
  console.log(
    `${pad("File", 40)} ${pad("Project", 12)} ${pad("Rows", 6)} ${pad("Ins", 6)} ${pad("Upd", 6)} ${pad("Same", 6)} ${pad("Stale", 6)} ${pad("Rej", 5)} Status`,
  );
  for (const o of outcomes) {
    console.log(
      `${pad(o.file.slice(0, 39), 40)} ${pad(o.project, 12)} ${pad(o.records, 6)} ${pad(o.counts.inserted, 6)} ${pad(o.counts.updated, 6)} ${pad(o.counts.unchanged, 6)} ${pad(o.counts.stale, 6)} ${pad(o.counts.rejected, 5)} ${o.status}${o.error ? ` — ${o.error}` : ""}`,
    );
  }
  const total = outcomes.reduce(
    (acc, o) => ({
      records: acc.records + o.records,
      inserted: acc.inserted + o.counts.inserted,
      updated: acc.updated + o.counts.updated,
      unchanged: acc.unchanged + o.counts.unchanged,
      stale: acc.stale + o.counts.stale,
      rejected: acc.rejected + o.counts.rejected,
    }),
    { records: 0, inserted: 0, updated: 0, unchanged: 0, stale: 0, rejected: 0 },
  );
  console.log(
    `${pad("TOTAL", 40)} ${pad("", 12)} ${pad(total.records, 6)} ${pad(total.inserted, 6)} ${pad(total.updated, 6)} ${pad(total.unchanged, 6)} ${pad(total.stale, 6)} ${pad(total.rejected, 5)}`,
  );
}

async function main(): Promise<number> {
  const args = parseCli();
  if (args.help) {
    console.log("Usage: npm run db:import -- [--dir data/raw] [--file <csv> ...] [--dry-run] [--force-update] [--batch-size 500]");
    return 0;
  }
  const batchSize = Math.min(Math.max(Number(args["batch-size"]) || 500, 50), 1000);
  const files = discoverFiles(args.dir!, args.file);
  if (files.length === 0) {
    console.error("No CSV files found. Place the four ticket exports in data/raw/ and re-run.");
    return 1;
  }

  // ---------------------------------------------------------------- dry run
  if (args["dry-run"]) {
    let projects: ProjectRef[] = DEFAULT_PROJECTS;
    let source = "built-in project list (offline)";
    if (optionalEnv("DATABASE_URL")) {
      const { sql } = connect();
      try {
        projects = await sql<ProjectRef[]>`select id, code, name, organization_id, file_name_hint from public.projects`;
        source = "database";
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    console.log(`Dry run — no data will be written. Projects from: ${source}\n`);
    const outcomes: FileOutcome[] = [];
    for (const f of files) {
      const name = path.basename(f);
      try {
        const pf = processFile(name, readFileSync(f), projects);
        outcomes.push({
          file: name,
          project: pf.project.code,
          status: "dry-run",
          records: pf.stats.records_in_file,
          counts: { inserted: pf.rows.length, updated: 0, unchanged: 0, stale: 0, rejected: pf.errors.length },
        });
        for (const e of pf.errors.slice(0, 20)) console.log(`  ✗ ${name} row ${e.rowNumber} (line ${e.line}) ${e.code}: ${e.message}`);
      } catch (err) {
        outcomes.push({ file: name, project: "-", status: "failed", records: 0, counts: { inserted: 0, updated: 0, unchanged: 0, stale: 0, rejected: 0 }, error: (err as Error).message });
      }
    }
    printSummary(outcomes);
    console.log("\n(Dry run: 'Ins' = valid rows that would be considered for insert/update.)");
    return outcomes.some((o) => o.status === "failed") ? 1 : 0;
  }

  // ---------------------------------------------------------------- import
  const { sql, target } = connect({ max: 1 });
  console.log(`Importing ${files.length} file(s) into ${target}`);
  const outcomes: FileOutcome[] = [];

  try {
    const [{ locked }] = await sql<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${IMPORT_LOCK_KEY})) as locked`;
    if (!locked) {
      console.error("Another import is running (advisory lock held). Aborting.");
      return 1;
    }

    const abandoned = await sql`
      update public.import_runs
         set status = 'failed', completed_at = now(),
             error_summary = coalesce(error_summary, 'Abandoned: the importer stopped before completing this run.')
       where status = 'running'
      returning id
    `;
    if (abandoned.length > 0) console.warn(`Marked ${abandoned.length} abandoned run(s) as failed.`);

    const projects = await sql<ProjectRef[]>`select id, code, name, organization_id, file_name_hint from public.projects`;
    const catalog = await loadCategoryCatalog(sql);
    const seenInRun = new Map<number, { projectId: string; file: string }>();

    for (const f of files) {
      const name = path.basename(f);
      const buffer = readFileSync(f);
      const size = statSync(f).size;
      const counts: Counts = { inserted: 0, updated: 0, unchanged: 0, stale: 0, rejected: 0 };
      const fileHash = sha256(buffer);

      const [prior] = await sql<{ id: string }[]>`
        select id from public.import_runs
        where file_hash = ${fileHash} and status in ('completed', 'completed_with_errors')
        order by completed_at desc limit 1
      `;
      const [run] = await sql<{ id: string }[]>`
        insert into public.import_runs
          (source_filename, file_hash, file_size_bytes, update_policy, importer_version, duplicate_of_run_id)
        values (${name}, ${fileHash}, ${size}, ${UPDATE_POLICY}, ${IMPORTER_VERSION}, ${prior?.id ?? null})
        returning id
      `;
      const runId = run.id;
      console.log(`\n▶ ${name} (${(size / 1024 / 1024).toFixed(2)} MB, sha256 ${fileHash.slice(0, 12)}…)${prior ? " — identical file imported before; verifying idempotently" : ""}`);

      let pf: ProcessedFile;
      try {
        pf = processFile(name, buffer, projects);
      } catch (err) {
        const code = err instanceof CsvStructureError ? "FILE_STRUCTURE_INVALID" : err instanceof ProjectMappingError ? "PROJECT_MAPPING_FAILED" : "FILE_PROCESSING_FAILED";
        const message = (err as Error).message;
        await sql`insert into public.import_errors (import_run_id, error_code, validation_error) values (${runId}, ${code}, ${message})`;
        await sql`
          update public.import_runs set status = 'failed', completed_at = now(), error_summary = ${`${code}: ${message}`}
          where id = ${runId}
        `;
        console.error(`  ✗ ${code}: ${message}`);
        outcomes.push({ file: name, project: "-", status: "failed", records: 0, counts, error: code });
        continue;
      }

      await sql`
        update public.import_runs
           set project_id = ${pf.project.id}, records_in_file = ${pf.stats.records_in_file},
               data_as_of = ${pf.stats.data_as_of}, min_created_at = ${pf.stats.min_created_at},
               max_created_at = ${pf.stats.max_created_at}
         where id = ${runId}
      `;
      console.log(`  project ${pf.project.code}; ${pf.stats.records_in_file} records; ${pf.errors.length} invalid; data as of ${pf.stats.data_as_of}`);

      try {
        // Row-level validation errors from parsing.
        if (pf.errors.length > 0) {
          await insertErrors(sql, pf.errors.map((e) => errorRow(runId, e)));
          counts.rejected += pf.errors.length;
        }

        // Duplicates across files within this same run.
        const rows: TransformedRow[] = [];
        const crossErrors: RowError[] = [];
        for (const row of pf.rows) {
          const seen = seenInRun.get(row.record.ticket_id);
          if (seen) {
            crossErrors.push({
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
        if (crossErrors.length > 0) {
          await insertErrors(sql, crossErrors.map((e) => errorRow(runId, e)));
          counts.rejected += crossErrors.length;
        }

        for (let i = 0; i < rows.length; i += batchSize) {
          const c = await processBatch(sql, catalog, runId, pf, rows.slice(i, i + batchSize), Boolean(args["force-update"]));
          counts.inserted += c.inserted;
          counts.updated += c.updated;
          counts.unchanged += c.unchanged;
          counts.stale += c.stale;
          counts.rejected += c.rejected;
          if (process.stdout.isTTY) process.stdout.write(`  … ${Math.min(i + batchSize, rows.length)}/${rows.length}\r`);
        }

        const status = counts.rejected > 0 ? "completed_with_errors" : "completed";
        const reconciliation = { ...pf.stats, classification_version: "rules-v1" };
        await sql`
          update public.import_runs
             set status = ${status}, completed_at = now(),
                 inserted_count = ${counts.inserted}, updated_count = ${counts.updated},
                 skipped_unchanged_count = ${counts.unchanged}, skipped_stale_count = ${counts.stale},
                 rejected_count = ${counts.rejected},
                 reconciliation = ${sql.json(reconciliation as unknown as Parameters<typeof sql.json>[0])},
                 error_summary = ${counts.rejected > 0 ? `${counts.rejected} row(s) rejected; see import_errors.` : null}
           where id = ${runId}
        `;
        const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.tickets where project_id = ${pf.project.id}`;
        console.log(`  ✓ ${status}: +${counts.inserted} inserted, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.stale} stale, ${counts.rejected} rejected — project now has ${n} tickets`);
        outcomes.push({ file: name, project: pf.project.code, status, records: pf.stats.records_in_file, counts });
      } catch (err) {
        const message = (err as Error).message;
        await sql`
          update public.import_runs set status = 'failed', completed_at = now(),
            inserted_count = ${counts.inserted}, updated_count = ${counts.updated},
            skipped_unchanged_count = ${counts.unchanged}, skipped_stale_count = ${counts.stale},
            rejected_count = ${counts.rejected}, error_summary = ${message.slice(0, 2000)}
          where id = ${runId}
        `.catch(() => {});
        console.error(`  ✗ failed: ${message}`);
        outcomes.push({ file: name, project: pf.project.code, status: "failed", records: pf.stats.records_in_file, counts, error: message.slice(0, 120) });
      }
    }

    await sql`select pg_advisory_unlock(hashtext(${IMPORT_LOCK_KEY}))`;
  } finally {
    await sql.end({ timeout: 5 });
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
