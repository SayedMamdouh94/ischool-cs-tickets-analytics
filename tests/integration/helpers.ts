import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import postgres from "postgres";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_PROJECTS } from "@/lib/ingest/default-projects";
import { processFile, type ProcessedFile } from "@/lib/ingest/file";

config({ path: path.resolve(__dirname, "../../.env.local"), quiet: true });

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
export const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
export const DATABASE_URL = process.env.DATABASE_URL ?? "";

/** Integration tests only ever run against a LOCAL Supabase stack. */
export const isLocalStack =
  /^http:\/\/(127\.0\.0\.1|localhost):/.test(SUPABASE_URL) && /@(127\.0\.0\.1|localhost):/.test(DATABASE_URL) && Boolean(SECRET_KEY);

export async function stackReachable(): Promise<boolean> {
  if (!isLocalStack) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: PUBLISHABLE_KEY } });
    return res.ok;
  } catch {
    return false;
  }
}

export function sql() {
  return postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
}

export function adminApi(): SupabaseClient {
  return createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function anonClient(): Promise<SupabaseClient> {
  return createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false } });
}

/** Creates (or reuses) a confirmed user with an optional application role and returns a signed-in client. */
export async function userClient(email: string, role: "admin" | "analyst" | null): Promise<{ client: SupabaseClient; userId: string }> {
  const password = "Integration#Test2026";
  const db = sql();
  try {
    let [u] = await db<{ id: string }[]>`select id from auth.users where email = ${email}`;
    if (!u) {
      const { data, error } = await adminApi().auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw error;
      u = { id: data.user.id };
    }
    if (role) {
      await db`insert into public.user_roles (user_id, role) values (${u.id}, ${role}) on conflict (user_id) do update set role = excluded.role`;
    } else {
      await db`delete from public.user_roles where user_id = ${u.id}`;
    }
    const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false } });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return { client, userId: u.id };
  } finally {
    await db.end();
  }
}

export async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<{ data: T; error: { message: string; code?: string } | null }> {
  const { data, error } = await client.rpc(fn, args);
  return { data: data as T, error };
}

let cached: ProcessedFile[] | null = null;
/** The original CSV exports, processed with the same pure pipeline as the importer. */
export function sourceFiles(): ProcessedFile[] {
  if (cached) return cached;
  const dir = path.resolve(__dirname, "../../data/raw");
  cached = readdirSync(dir)
    .filter((f) => f.endsWith(".csv"))
    .map((f) => processFile(f, readFileSync(path.join(dir, f)), DEFAULT_PROJECTS));
  return cached;
}

/** Calendar date of an instant in Africa/Cairo. */
export function cairoDate(epochMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochMs));
}
