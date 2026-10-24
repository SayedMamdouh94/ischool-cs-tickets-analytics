import "server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { CsvStructureError } from "@/lib/ingest/csv";
import { siteUrl } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { callRpc } from "@/lib/supabase/rpc";
import { IMPORT_BUCKET, MAX_IMPORT_BYTES } from "./constants";
import { readUpload, type UploadFormat } from "./read-upload";
import { validateUpload, type ImportIssue, type StageRow } from "./validate";

/**
 * Background import worker. Runs server-side with the service role, never with
 * a user's session, and only ever acts on jobs an administrator created and
 * (for imports) confirmed. All state lives in import_jobs, so any invocation
 * can resume any job:
 *
 *   validating: download → parse → validate → stage rows in idempotent chunks → preview
 *   importing:  apply staged rows in atomic batches (pg_cron does the same without us)
 *
 * A lease (90 s, renewed per chunk) stops two workers from processing the same
 * job. When the time budget of this invocation runs out, the lease is released
 * and another invocation is requested, so long files continue seamlessly.
 */

/** Work budget per invocation; the route's maxDuration is 60 s. */
export const WORKER_BUDGET_MS = 45_000;
const LEASE_SECONDS = 90;
const STAGE_CHUNK_BYTES = 600_000;
const STAGE_CHUNK_ROWS = 500;
const APPLY_BATCH = 500;

interface ClaimedJob {
  id: string;
  status: "validating" | "importing";
  mode: "upsert" | "archive_and_start";
  storage_path: string;
  original_filename: string;
  file_format: UploadFormat;
  file_size_bytes: number | null;
  file_hash: string | null;
  rows_staged: number;
  rows_total: number | null;
  attempts: number;
  project: { code: string; name: string; organization_id: number };
  statuses: string[];
  mapped_topics: string[];
}

class LeaseLost extends Error {}
class BudgetExhausted extends Error {}

type Admin = ReturnType<typeof createAdminClient>;

async function rpc<T>(db: Admin, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await callRpc<T>(db, fn, args);
  if (error) {
    if (/LEASE_LOST/.test(error.message)) throw new LeaseLost(error.message);
    const err = new Error(error.message) as Error & { code?: string };
    err.code = error.code;
    throw err;
  }
  return data;
}

/** Network problems, timeouts and rate limits are worth retrying; data errors are not. */
function isTransient(err: unknown): boolean {
  const e = err as { code?: string; message?: string; name?: string };
  return (
    e?.code === "57014" || // statement timeout
    e?.code === "40001" ||
    e?.code === "40P01" ||
    e?.code === "55P03" ||
    e?.name === "AbortError" ||
    /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timeout|502|503|504|429/i.test(e?.message ?? "")
  );
}

function chunkRows(rows: StageRow[]): StageRow[][] {
  const chunks: StageRow[][] = [];
  let current: StageRow[] = [];
  let size = 0;
  for (const row of rows) {
    const s = Buffer.byteLength(JSON.stringify(row));
    if (current.length > 0 && (size + s > STAGE_CHUNK_BYTES || current.length >= STAGE_CHUNK_ROWS)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += s;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function download(db: Admin, path: string): Promise<Buffer> {
  const { data, error } = await db.storage.from(IMPORT_BUCKET).download(path);
  if (error || !data) {
    const err = new Error(`Could not read the uploaded file: ${error?.message ?? "not found"}`);
    throw err;
  }
  return Buffer.from(await data.arrayBuffer());
}

async function validateJob(db: Admin, worker: string, job: ClaimedJob, deadline: number): Promise<void> {
  const buffer = await download(db, job.storage_path);
  const hash = createHash("sha256").update(buffer).digest("hex");
  const fail = (code: string, message: string, issues: ImportIssue[] = []) =>
    rpc(db, "worker_finish_validation", {
      p_job_id: job.id,
      p_worker: worker,
      p_summary: { file_error: message, file_error_code: code, rows_total: 0, format: job.file_format, file_hash: hash },
      p_file_issues: [{ severity: "error", code, message }, ...issues],
    });

  if (buffer.length > MAX_IMPORT_BYTES) {
    await fail("FILE_TOO_LARGE", `The file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
    return;
  }

  let outcome: ReturnType<typeof validateUpload>;
  try {
    const contents = await readUpload(buffer, job.file_format);
    outcome = validateUpload(contents, {
      project: job.project,
      configuredStatuses: new Set(job.statuses),
      mappedTopics: new Set(job.mapped_topics),
      now: new Date(),
    });
  } catch (err) {
    if (err instanceof CsvStructureError) {
      await fail(err.code, err.message);
      return;
    }
    throw err;
  }

  const ok = await rpc<boolean>(db, "worker_set_file", {
    p_job_id: job.id,
    p_worker: worker,
    p_hash: hash,
    p_size: buffer.length,
    p_rows_total: outcome.summary.rows_total,
  });
  if (!ok) throw new LeaseLost("lease lost before staging");

  // Rows 1..rows_staged are already in the database (earlier invocation); continue after them.
  const remaining = outcome.stageRows.filter((r) => r.row_number > job.rows_staged);
  for (const chunk of chunkRows(remaining)) {
    if (Date.now() > deadline) throw new BudgetExhausted();
    const first = chunk[0].row_number;
    const last = chunk[chunk.length - 1].row_number;
    const issues = outcome.rowIssues.filter((i) => i.row_number !== undefined && i.row_number >= first && i.row_number <= last);
    await rpc(db, "worker_stage_rows", { p_job_id: job.id, p_worker: worker, p_rows: chunk, p_issues: issues });
  }

  await rpc(db, "worker_finish_validation", {
    p_job_id: job.id,
    p_worker: worker,
    p_summary: { ...outcome.summary, file_hash: hash },
    p_file_issues: outcome.fileIssues,
  });
}

async function applyJob(db: Admin, worker: string, job: ClaimedJob, deadline: number): Promise<void> {
  for (;;) {
    if (Date.now() > deadline) throw new BudgetExhausted();
    const result = await rpc<{ done: boolean; status: string }>(db, "worker_apply_batch", {
      p_job_id: job.id,
      p_worker: worker,
      p_batch_size: APPLY_BATCH,
    });
    if (result.done) return;
  }
}

export interface WorkerResult {
  processed: string[];
  /** Jobs left unfinished because the time budget ran out (another run was requested). */
  continued: string[];
  errors: { jobId: string; message: string }[];
}

/** Processes the given job (or any runnable job) until done or the budget is used. */
export async function runImportWorker(opts: { jobId?: string; budgetMs?: number } = {}): Promise<WorkerResult> {
  const db = createAdminClient();
  const worker = `web-${randomUUID()}`;
  const deadline = Date.now() + (opts.budgetMs ?? WORKER_BUDGET_MS);
  const result: WorkerResult = { processed: [], continued: [], errors: [] };

  while (Date.now() < deadline) {
    let job: ClaimedJob | null;
    try {
      job = await rpc<ClaimedJob | null>(db, "worker_claim_job", { p_worker: worker, p_job_id: opts.jobId ?? null, p_lease_seconds: LEASE_SECONDS });
    } catch (err) {
      result.errors.push({ jobId: opts.jobId ?? "-", message: (err as Error).message });
      break;
    }
    if (!job) break;

    try {
      if (job.status === "validating") await validateJob(db, worker, job, deadline);
      else await applyJob(db, worker, job, deadline);
      result.processed.push(job.id);
    } catch (err) {
      if (err instanceof LeaseLost) {
        // Another worker took over (or the job was cancelled): nothing to do.
      } else if (err instanceof BudgetExhausted) {
        await rpc(db, "worker_release", { p_job_id: job.id, p_worker: worker }).catch(() => {});
        result.continued.push(job.id);
        break;
      } else {
        const message = (err as Error).message ?? String(err);
        result.errors.push({ jobId: job.id, message });
        await rpc(db, "worker_fail", { p_job_id: job.id, p_worker: worker, p_message: message.slice(0, 2000), p_retryable: true }).catch(() => {});
        if (isTransient(err)) result.continued.push(job.id);
      }
    }
    if (opts.jobId) break;
  }
  return result;
}

/** Bearer secret shared with the pg_cron watchdog and used for self-continuation. */
export function workerSecret(): string | null {
  const s = process.env.IMPORT_WORKER_SECRET;
  return s && s.length >= 32 ? s : null;
}

export function verifyWorkerSecret(header: string | null): boolean {
  const secret = workerSecret();
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Asks a fresh invocation of the worker route to continue (only when the secret is configured). */
export async function requestWorkerRun(jobId?: string): Promise<boolean> {
  const secret = workerSecret();
  if (!secret) return false;
  try {
    const res = await fetch(`${siteUrl()}/api/imports/worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jobId: jobId ?? null }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.status === 202;
  } catch {
    return false;
  }
}

/**
 * Runs the worker after the current response has been sent (keeps the function
 * alive up to the route's maxDuration). Unfinished work is handed to a new
 * invocation; if that is not possible, pg_cron and the job page pick it up.
 */
export function scheduleWorker(jobId?: string): void {
  after(async () => {
    const r = await runImportWorker({ jobId });
    for (const e of r.errors) console.error(`[import-worker] job ${e.jobId}: ${e.message}`);
    if (r.continued.length > 0) await requestWorkerRun(jobId);
  });
}
