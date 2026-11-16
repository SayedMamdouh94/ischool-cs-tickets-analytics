import { readFileSync } from "node:fs";
import path from "node:path";
import { it, expect } from "vitest";
import { parseTicketCsv } from "@/lib/ingest/csv";
import { SOURCE_COLUMNS } from "@/lib/ingest/columns";
import { runImportWorker, WORKER_BUDGET_MS } from "@/lib/imports/worker";
import { PUBLISHABLE_KEY, adminApi, rpc, sql, stackReachable, userClient } from "./helpers";

/**
 * Opt-in load test of the web import pipeline (local stack only):
 *
 *   LOAD_TEST=1 [LOAD_FORMAT=csv|xlsx] [LOAD_ROWS=41000] [LOAD_UNIQUE=1] [LOAD_BUDGET_MS=45000] \
 *     npx vitest run --project integration tests/integration/load.test.ts
 *
 * Builds a synthetic export from the DEMI 3rd Intake rows (new Ticket_IDs, a
 * throwaway project/cycle), runs the worker with the production time budget
 * until done, prints timings, invocations, slowest database call per function
 * and peak memory, then removes everything it created.
 */
const FORMAT = (process.env.LOAD_FORMAT ?? "csv") as "csv" | "xlsx";
const ROWS = Number(process.env.LOAD_ROWS ?? 41000);
const BUDGET = Number(process.env.LOAD_BUDGET_MS ?? WORKER_BUDGET_MS);

it.skipIf(!process.env.LOAD_TEST || !(await stackReachable()))(`load: ${ROWS} rows (${FORMAT}) through the web pipeline with the production time budget`, async () => {
  const admin = (await userClient("it-admin@local.test", "admin")).client;
  const db = sql();
  await rpc(admin, "create_reporting_cycle", { p_cycle: { code: "IT_LOAD", name: "Load test" }, p_make_current: false });
  await rpc(admin, "create_project", { p_project: { code: "IT_LOAD_P", name: "Load", program: "LOAD", intake: "x", organization_id: 990900 }, p_cycle: "IT_LOAD" });
  const src = parseTicketCsv(readFileSync(path.resolve(__dirname, "../../data/raw/DEMI 3rd Intake Edu Tickets.csv")));
  const out: Record<string, string>[] = [];
  for (let i = 0; i < ROWS; i++) out.push({ ...src.records[i % src.records.length].values, Ticket_ID: String(800000000 + i), Organization_ID: "990900", ...(process.env.LOAD_UNIQUE ? { Message: `${src.records[i % src.records.length].values.Message} #${i} ${Math.random().toString(36).slice(2)}` } : {}) });
  let file: Buffer;
  if (FORMAT === "csv") {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    file = Buffer.from(`﻿${[SOURCE_COLUMNS.join(","), ...out.map((r) => SOURCE_COLUMNS.map((c) => esc(r[c])).join(","))].join("\r\n")}\r\n`);
  } else {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Tickets");
    ws.addRow([...SOURCE_COLUMNS]);
    for (const r of out) ws.addRow(SOURCE_COLUMNS.map((c) => r[c]));
    file = Buffer.from(await wb.xlsx.writeBuffer());
  }
  const mb = +(file.length / 1024 / 1024).toFixed(1);
  const { data: job, error } = await rpc<{ id: string; storage_path: string }>(admin, "create_import_job", { p_spec: { mode: "upsert", project_code: "IT_LOAD_P", filename: `it-load.${FORMAT}`, size_bytes: file.length } });
  expect(error).toBeNull();
  const { data: signed } = await adminApi().storage.from("imports").createSignedUploadUrl(job.storage_path);
  const put = await fetch(signed!.signedUrl, { method: "PUT", headers: { "content-type": FORMAT === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", apikey: PUBLISHABLE_KEY }, body: new Uint8Array(file) });
  expect(put.status).toBe(200);
  await rpc(admin, "mark_import_uploaded", { p_job_id: job.id });
  await db`select pg_stat_statements_reset()`;

  let peakRss = 0;
  const timer = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 200);
  const invocations: number[] = [];
  const status = async () => (await rpc<{ job: { status: string; preview_version: number; rows_staged: number } }>(admin, "get_import_job", { p_job_id: job.id })).data.job;
  let t0 = Date.now();
  for (let i = 0; i < 400 && (await status()).status !== "ready"; i++) {
    const t = Date.now();
    await runImportWorker({ jobId: job.id, budgetMs: BUDGET });
    invocations.push(Date.now() - t);
  }
  const validateMs = Date.now() - t0;
  const ready = await status();
  expect(ready.status).toBe("ready");
  const validationCalls = invocations.length;
  const c = await rpc(admin, "confirm_import_job", { p_job_id: job.id, p_policy: "all_or_nothing", p_preview_version: ready.preview_version });
  expect(c.error).toBeNull();
  t0 = Date.now();
  for (let i = 0; i < 400 && (await status()).status === "importing"; i++) {
    const t = Date.now();
    await runImportWorker({ jobId: job.id, budgetMs: BUDGET });
    invocations.push(Date.now() - t);
  }
  const applyMs = Date.now() - t0;
  clearInterval(timer);
  const done = await status();
  const [m] = await db<{ max_ms: number }[]>`select round(max(max_exec_time))::int as max_ms from pg_stat_statements where query like '%pgrst_call%'`;
  const perFn = await db<{ fn: string; max_ms: number; calls: number }[]>`
    select substring(query from '"public"\."([a-z_]+)"') as fn, round(max(max_exec_time))::int as max_ms, sum(calls)::int as calls
    from pg_stat_statements where query like '%pgrst_call%' group by 1 order by 2 desc limit 6`;
  process.stdout.write(`\nPERFN ${JSON.stringify(perFn)}\n`);
  const [{ n }] = await db<{ n: number }[]>`select count(*)::int as n from public.tickets t join public.projects p on p.id = t.project_id where p.code = 'IT_LOAD_P'`;
  const report = { format: FORMAT, rows: ROWS, budgetMs: BUDGET, fileMB: mb, validateMs, validationInvocations: validationCalls, applyMs, applyInvocations: invocations.length - validationCalls, longestInvocationMs: Math.max(...invocations), slowestDbCallMs: m.max_ms, peakRssMB: Math.round(peakRss / 1024 / 1024), status: done.status, tickets: n };
  process.stdout.write(`\nLOAD ${JSON.stringify(report)}\n`);

  // cleanup
  const paths = await db<{ storage_path: string; import_run_id: string | null }[]>`select storage_path, import_run_id from public.import_jobs where original_filename like 'it-load.%'`;
  await adminApi().storage.from("imports").remove(paths.map((p) => p.storage_path));
  await db`delete from public.import_jobs where original_filename like 'it-load.%'`;
  await db`delete from public.tickets where project_id in (select id from public.projects where code = 'IT_LOAD_P')`;
  await db`delete from public.import_runs where project_id in (select id from public.projects where code = 'IT_LOAD_P')`;
  await db`delete from public.projects where code = 'IT_LOAD_P'`;
  await db`delete from public.reporting_cycles where code = 'IT_LOAD'`;
  await db.end();
  expect(n).toBe(ROWS);
}, 1_800_000);
