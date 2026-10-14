import { execFileSync } from "node:child_process";
import { optionalEnv } from "./env";

/**
 * Minimal Supabase Management API client for the admin CLI.
 *
 * Token resolution (never logged): SUPABASE_ACCESS_TOKEN, otherwise the
 * Supabase CLI's own login stored in the macOS keychain ("Supabase CLI").
 */
const API = "https://api.supabase.com";

let cachedToken: string | null = null;

export function managementToken(): string {
  if (cachedToken) return cachedToken;
  const fromEnv = optionalEnv("SUPABASE_ACCESS_TOKEN");
  if (fromEnv) return (cachedToken = fromEnv);
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync("security", ["find-generic-password", "-s", "Supabase CLI", "-a", "supabase", "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 60_000,
      }).trim();
      let token = raw;
      if (raw.startsWith("go-keyring-base64:")) token = Buffer.from(raw.slice("go-keyring-base64:".length), "base64").toString("utf8");
      else if (raw.startsWith("go-keyring-encoded:")) token = Buffer.from(raw.slice("go-keyring-encoded:".length), "hex").toString("utf8");
      if (/^sbp_[0-9a-f]{40}$/.test(token)) return (cachedToken = token);
    } catch {
      // fall through
    }
  }
  throw new Error("No Supabase access token: run `supabase login`, or set SUPABASE_ACCESS_TOKEN in the shell.");
}

/** Project ref from SUPABASE_PROJECT_REF or the *.supabase.co project URL. */
export function projectRef(): string {
  const explicit = optionalEnv("SUPABASE_PROJECT_REF");
  if (explicit) return explicit;
  const url = optionalEnv("NEXT_PUBLIC_SUPABASE_URL");
  const m = url ? /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url) : null;
  if (!m) throw new Error("Cannot determine the Supabase project ref (set SUPABASE_PROJECT_REF or a *.supabase.co NEXT_PUBLIC_SUPABASE_URL).");
  return m[1];
}

export class ManagementApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Errors worth retrying: rate limiting, gateway/connection problems — never SQL errors. */
function isTransient(status: number, body: string): boolean {
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  if (status >= 500 && /ECONNRESET|ETIMEDOUT|timeout|connection (terminated|reset|refused)|too many (connections|clients)/i.test(body)) return true;
  return false;
}

export async function managementFetch<T>(path: string, init: { method?: string; body?: unknown; retries?: number } = {}): Promise<T> {
  const retries = init.retries ?? 6;
  for (let attempt = 1; ; attempt++) {
    let status = 0;
    let text = "";
    try {
      const res = await fetch(`${API}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${managementToken()}`,
          "Content-Type": "application/json",
          "User-Agent": "cs-tickets-analytics-cli",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(180_000),
      });
      status = res.status;
      text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : null) as T;
      if (attempt > retries || !isTransient(status, text)) {
        throw new ManagementApiError(`Management API ${init.method ?? "GET"} ${path.replace(/\/projects\/[a-z0-9]+/, "/projects/<ref>")} failed (${status}): ${text.slice(0, 500)}`, status);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** (attempt - 1));
      console.warn(`  ↻ Management API ${status}; retry ${attempt}/${retries} in ${Math.round(delay / 1000)}s`);
      await new Promise((r) => setTimeout(r, delay));
    } catch (err) {
      if (err instanceof ManagementApiError) throw err;
      // Network-level failure (DNS, reset, timeout): retry.
      if (attempt > retries) throw err;
      const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      console.warn(`  ↻ Management API network error (${(err as Error).name}); retry ${attempt}/${retries} in ${Math.round(delay / 1000)}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Runs SQL through POST /v1/projects/{ref}/database/query (Beta). */
export async function runSql<T = Record<string, unknown>>(
  query: string,
  options: { parameters?: unknown[]; readOnly?: boolean; retries?: number } = {},
): Promise<T[]> {
  const body: Record<string, unknown> = { query };
  if (options.parameters && options.parameters.length > 0) body.parameters = options.parameters;
  if (options.readOnly) body.read_only = true;
  const result = await managementFetch<T[] | { result?: T[] }>(`/v1/projects/${projectRef()}/database/query`, {
    method: "POST",
    body,
    retries: options.retries,
  });
  if (Array.isArray(result)) return result;
  return (result?.result ?? []) as T[];
}
