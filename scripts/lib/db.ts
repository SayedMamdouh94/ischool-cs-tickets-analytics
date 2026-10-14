import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { optionalEnv, requireEnv } from "./env";

/**
 * Database access for the admin CLI, with two interchangeable transports that
 * run the SAME SQL text:
 *
 *  - "postgres":     a direct connection (DATABASE_URL). Parameters are bound
 *                    natively; scripts use the simple query protocol.
 *  - "supabase-cli": no database password — `supabase db query`, i.e. the
 *                    Management API SQL endpoint, authorized by the Supabase
 *                    CLI's own login. Parameters are encoded client-side as
 *                    literals (see sqlLiteral).
 *
 * Selection: DB_TRANSPORT=postgres|supabase-cli, otherwise postgres when
 * DATABASE_URL is set, otherwise supabase-cli for a *.supabase.co project.
 * SUPABASE_CLI_TARGET=local points the CLI transport at `supabase start`.
 *
 * In both transports `script()` runs its statements inside one `DO` block,
 * i.e. atomically: any failing statement rolls the whole script back.
 */
export type Param = string | number | boolean | null | undefined | Date | Record<string, unknown> | unknown[];

export interface Db {
  readonly kind: "postgres" | "supabase-cli";
  readonly target: string;
  readonly isLocal: boolean;
  /** One statement; placeholders $1..$n. */
  query<T = Record<string, unknown>>(text: string, params?: Param[]): Promise<T[]>;
  /** Several statements, executed atomically. Embed data with sqlLiteral()/jsonLiteral(). */
  script(text: string): Promise<void>;
  end(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Literals (used by the CLI transport and for embedding batch data in scripts)
// ---------------------------------------------------------------------------

/** Dollar-quotes a string with a random tag that provably does not occur in it. */
export function dollarQuote(value: string): string {
  for (;;) {
    const tag = `q${randomBytes(9).toString("hex")}`;
    if (!value.includes(`$${tag}$`) && !value.includes(tag)) return `$${tag}$${value}$${tag}$`;
  }
}

export function sqlLiteral(value: Param): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Refusing to encode a non-finite number as SQL.");
    return String(value);
  }
  if (value instanceof Date) return dollarQuote(value.toISOString());
  if (typeof value === "object") return dollarQuote(JSON.stringify(value));
  return dollarQuote(String(value));
}

/**
 * Wraps several statements in ONE `DO` block: a single statement that runs
 * atomically under both the simple and the extended (prepared) protocol, so
 * every transport behaves identically. The outer tag never occurs inside.
 */
export function atomicBlock(statements: string): string {
  const body = statements.trim();
  for (;;) {
    const tag = `do_${randomBytes(9).toString("hex")}`;
    if (!body.includes(tag)) return `do $${tag}$\nbegin\n${body}\nend\n$${tag}$;`;
  }
}

/** A jsonb literal for embedding a whole batch in a script. */
export function jsonLiteral(value: unknown): string {
  return `${dollarQuote(JSON.stringify(value))}::jsonb`;
}

/**
 * Replaces $1..$n with literals in a single left-to-right pass (inserted text
 * is never rescanned). Only used with this codebase's static SQL texts.
 */
export function inlineParams(text: string, params: Param[] = []): string {
  return text.replace(/\$(\d+)(?![\w$])/g, (match, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) throw new Error(`SQL references ${match} but only ${params.length} parameter(s) were given.`);
    return sqlLiteral(params[i]);
  });
}

// ---------------------------------------------------------------------------
// postgres transport
// ---------------------------------------------------------------------------

const DATABASE_URL_HINT =
  "Set DATABASE_URL (Supabase Session pooler, port 5432) — or leave it unset to use the passwordless supabase-cli transport.";

/** Describes the target without revealing credentials. */
export function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/** Low-level postgres.js connection (used by the postgres transport). */
export function connect(options: { max?: number } = {}): { sql: Sql; target: string; isLocal: boolean } {
  const url = requireEnv("DATABASE_URL", DATABASE_URL_HINT);
  const u = new URL(url);
  const isLocal = ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
  if (u.port === "6543") {
    throw new Error(
      "DATABASE_URL points at the Supabase transaction pooler (port 6543). Use the Session pooler (port 5432) or the direct connection.",
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
      // BIGINT (ticket IDs, counts) as JS numbers; all values are far below 2^53.
      bigint: { to: 20, from: [20], serialize: (x: number | bigint | string) => String(x), parse: (x: string) => Number(x) },
    },
  });
  return { sql, target: describeTarget(url), isLocal };
}

export type Sql = postgres.Sql;

class PostgresDb implements Db {
  readonly kind = "postgres" as const;
  readonly target: string;
  readonly isLocal: boolean;
  private readonly sql: Sql;

  constructor() {
    const c = connect({ max: 1 });
    this.sql = c.sql;
    this.target = c.target;
    this.isLocal = c.isLocal;
  }

  async query<T>(text: string, params: Param[] = []): Promise<T[]> {
    // postgres.js serializes objects/arrays itself for json/jsonb parameters
    // (stringifying here would double-encode them as a JSON string scalar).
    const values = params.map((p) => (p === undefined ? null : p instanceof Date ? p.toISOString() : p));
    const rows = await this.sql.unsafe(text, values as postgres.ParameterOrJSON<never>[]);
    return rows as unknown as T[];
  }

  async script(text: string): Promise<void> {
    await this.sql.unsafe(atomicBlock(text));
  }

  async end(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// supabase-cli transport (Management API SQL endpoint, no database password)
// ---------------------------------------------------------------------------

/** Request size limit observed for the endpoint is ~1 MB; stay well below. */
export const CLI_MAX_SQL_BYTES = 700_000;

function linkedProjectRef(): string {
  const explicit = optionalEnv("SUPABASE_PROJECT_REF");
  if (explicit) return explicit;
  const url = optionalEnv("NEXT_PUBLIC_SUPABASE_URL") ?? "";
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url);
  if (!m) throw new Error("supabase-cli transport needs SUPABASE_PROJECT_REF or a *.supabase.co NEXT_PUBLIC_SUPABASE_URL.");
  return m[1];
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("supabase", args, { maxBuffer: 256 * 1024 * 1024, timeout: 300_000, env: { ...process.env, SUPABASE_YES: "1" } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((err as { code?: number }).code) : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

/** Extracts the first complete top-level JSON object from CLI output (string-aware). */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function parseCliJson(stdout: string): { rows?: unknown[]; error?: { message?: string; code?: string }; _tag?: string } | null {
  const json = firstJsonObject(stdout);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export class CliSqlError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

class SupabaseCliDb implements Db {
  readonly kind = "supabase-cli" as const;
  readonly target: string;
  readonly isLocal: boolean;
  private readonly targetArgs: string[];
  private readonly dir = mkdtempSync(path.join(tmpdir(), "cs-sql-"));

  constructor() {
    if (optionalEnv("SUPABASE_CLI_TARGET") === "local") {
      this.targetArgs = ["--local"];
      this.target = "local Supabase stack (via supabase CLI)";
      this.isLocal = true;
    } else {
      const ref = linkedProjectRef();
      // Always name the project explicitly (never rely on whichever folder is linked).
      this.targetArgs = ["--linked", "--project-ref", ref];
      this.target = `project ${ref} (Management API via supabase CLI)`;
      this.isLocal = false;
    }
  }

  private async exec(text: string, attempt = 1): Promise<unknown[]> {
    if (Buffer.byteLength(text) > CLI_MAX_SQL_BYTES * 1.4) {
      throw new CliSqlError(`SQL request too large (${Buffer.byteLength(text)} bytes).`, false);
    }
    // The SQL (which may contain ticket text) goes through a private temp file,
    // never the command line, and is deleted immediately afterwards.
    const file = path.join(this.dir, `${randomBytes(8).toString("hex")}.sql`);
    writeFileSync(file, text, { mode: 0o600 });
    let result: { stdout: string; stderr: string; code: number };
    try {
      result = await runCli(["db", "query", ...this.targetArgs, "-o", "json", "-f", file]);
    } finally {
      rmSync(file, { force: true });
    }
    const parsed = parseCliJson(result.stdout);
    if (result.code === 0 && parsed?._tag !== "Error") {
      // Statements without a result set print only a command tag (e.g. "UPDATE 3", "DO").
      return parsed && Array.isArray(parsed.rows) ? parsed.rows : [];
    }
    const message = (parsed?.error?.message ?? (result.stderr || result.stdout)).replace(/\s+/g, " ").trim().slice(0, 600);
    const transient = /timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|502|503|504|429|rate limit|too many (connections|clients)|connection (terminated|reset|refused)|Initialising login role failed/i.test(
      message,
    );
    if (transient && attempt <= 5) {
      const delay = Math.min(30_000, 1500 * 2 ** (attempt - 1));
      console.warn(`  ↻ supabase db query: transient error, retry ${attempt}/5 in ${Math.round(delay / 1000)}s`);
      await new Promise((r) => setTimeout(r, delay));
      return this.exec(text, attempt + 1);
    }
    throw new CliSqlError(message || `supabase db query failed (exit ${result.code})`, transient);
  }

  async query<T>(text: string, params: Param[] = []): Promise<T[]> {
    return (await this.exec(inlineParams(text, params))) as T[];
  }

  async script(text: string): Promise<void> {
    await this.exec(atomicBlock(text));
  }

  async end(): Promise<void> {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export function connectDb(): Db {
  const choice = optionalEnv("DB_TRANSPORT");
  if (choice === "postgres") return new PostgresDb();
  if (choice === "supabase-cli") return new SupabaseCliDb();
  if (choice) throw new Error(`Unknown DB_TRANSPORT "${choice}" (use postgres or supabase-cli).`);
  return optionalEnv("DATABASE_URL") ? new PostgresDb() : new SupabaseCliDb();
}

// ---------------------------------------------------------------------------
// Retries (postgres transport)
// ---------------------------------------------------------------------------

const TRANSIENT_CODES = new Set(["08000", "08001", "08003", "08004", "08006", "40001", "40P01", "53300", "57P01", "57P03"]);
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
  if (err instanceof CliSqlError) return err.transient;
  const e = err as { code?: string; errno?: string };
  return Boolean((e?.code && (TRANSIENT_CODES.has(e.code) || TRANSIENT_ERRNOS.has(e.code))) || (e?.errno && TRANSIENT_ERRNOS.has(e.errno)));
}

export async function withRetry<T>(label: string, fn: (attempt: number) => Promise<T>, options: { retries?: number; baseDelayMs?: number } = {}): Promise<T> {
  const retries = options.retries ?? 4;
  const base = options.baseDelayMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt > retries || !isTransientError(err)) throw err;
      const delay = base * 2 ** (attempt - 1) + Math.floor(Math.random() * base);
      console.warn(`  ↻ ${label}: transient error, retry ${attempt}/${retries} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
