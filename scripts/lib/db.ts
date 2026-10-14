import postgres from "postgres";
import { requireEnv } from "./env";

export type Sql = postgres.Sql;

const DATABASE_URL_HINT =
  "Set DATABASE_URL in .env.local to a Postgres connection string with privileges to write the schema " +
  "(local: postgresql://postgres:postgres@127.0.0.1:55322/postgres; Supabase: the 'Session pooler' or direct " +
  "connection string from Project Settings → Database). Never commit it.";

/** Describes the target without revealing credentials. */
export function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

export function connect(options: { max?: number } = {}): { sql: Sql; target: string; isLocal: boolean } {
  const url = requireEnv("DATABASE_URL", DATABASE_URL_HINT);
  const u = new URL(url);
  const isLocal = ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
  if (u.port === "6543") {
    throw new Error(
      "DATABASE_URL points at the Supabase transaction pooler (port 6543). The importer needs session-level " +
        "features (advisory locks, transactions); use the Session pooler (port 5432) or the direct connection.",
    );
  }
  const sql = postgres(url, {
    max: options.max ?? 1,
    ssl: isLocal ? false : "require",
    idle_timeout: 30,
    connect_timeout: 30,
    onnotice: () => {},
    connection: { application_name: "cs-tickets-analytics-cli" },
    types: {
      // Return BIGINT (ticket IDs, counts) as JS numbers; all values are far below 2^53.
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | bigint | string) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  });
  return { sql, target: describeTarget(url), isLocal };
}

const TRANSIENT_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
]);
const TRANSIENT_ERRNOS = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
]);

export function isTransientError(err: unknown): boolean {
  const e = err as { code?: string; errno?: string };
  return Boolean((e?.code && (TRANSIENT_CODES.has(e.code) || TRANSIENT_ERRNOS.has(e.code))) || (e?.errno && TRANSIENT_ERRNOS.has(e.errno)));
}

export async function withRetry<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
  options: { retries?: number; baseDelayMs?: number; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  const retries = options.retries ?? 4;
  const base = options.baseDelayMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt > retries || !isTransientError(err)) throw err;
      options.onRetry?.(err, attempt);
      const delay = base * 2 ** (attempt - 1) + Math.floor(Math.random() * base);
      console.warn(`  ↻ ${label}: transient error (${(err as { code?: string }).code ?? "unknown"}), retry ${attempt}/${retries} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export const IMPORT_LOCK_KEY = "cs-tickets-analytics:import";
