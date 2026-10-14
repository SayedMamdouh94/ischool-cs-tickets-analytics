import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { jsonLiteral, type Db } from "./db";

/**
 * Temporary, clearly-labelled test accounts for production verification.
 * Passwords are random, exist only in memory, and are never printed.
 * Accounts live under the reserved `.invalid` TLD so they can never receive mail.
 */
export const TEST_DOMAIN = "cs-analytics-smoke.invalid";

export interface TestUser {
  email: string;
  password: string;
  role: "admin" | "analyst" | null;
  id: string;
}

export function randomPassword(): string {
  // Satisfies the 12+ characters / upper / lower / digit policy.
  return `Sm0ke-${randomBytes(18).toString("base64url")}aA1`;
}

export function adminApi(url: string, secret: string): SupabaseClient {
  return createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function createTestUsers(db: Db, admin: SupabaseClient, roles: ("admin" | "analyst" | null)[], label: string): Promise<TestUser[]> {
  const stamp = `${Date.now()}`;
  const users: TestUser[] = roles.map((role) => ({
    email: `${label}-${role ?? "norole"}-${stamp}@${TEST_DOMAIN}`,
    password: randomPassword(),
    role,
    id: "",
  }));
  for (const u of users) {
    const { data, error } = await admin.auth.admin.createUser({
      email: u.email,
      password: u.password,
      email_confirm: true,
      user_metadata: { purpose: "automated production smoke test", temporary: true },
    });
    if (error) throw new Error(`could not create temporary user: ${error.message}`);
    u.id = data.user.id;
  }
  const grants = users.filter((u) => u.role).map((u) => ({ user_id: u.id, role: u.role }));
  if (grants.length) {
    await db.script(`
insert into public.user_roles (user_id, role)
select user_id, role from jsonb_to_recordset(${jsonLiteral(grants)}) as g(user_id uuid, role text);`);
  }
  return users;
}

export async function signIn(url: string, publishableKey: string, u: TestUser): Promise<SupabaseClient> {
  const client = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`sign-in failed for a temporary ${u.role ?? "no-role"} user: ${error.message}`);
  return client;
}

/**
 * Removes temporary users. Only rows of THESE user ids are touched. When a
 * temporary admin is the only administrator, the last-admin guard trigger is
 * suspended inside the same transaction (the table is exclusively locked, so
 * no other session can observe it disabled) and re-enabled before commit.
 * Audit events written by the test users are kept (user_id becomes NULL).
 */
export async function removeTestUsers(db: Db, admin: SupabaseClient, users: TestUser[]): Promise<{ removed: number; leftover: number }> {
  const ids = users.map((u) => u.id).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return { removed: 0, leftover: 0 };
  const idList = jsonLiteral(ids);
  const [{ others }] = await db.query<{ others: number }>(
    `select count(*)::int as others from public.user_roles
      where role = 'admin' and user_id not in (select (jsonb_array_elements_text($1::jsonb))::uuid)`,
    [ids],
  );
  if (Number(others) > 0) {
    await db.script(`delete from public.user_roles where user_id in (select (jsonb_array_elements_text(${idList}))::uuid);`);
  } else {
    await db.script(`
alter table public.user_roles disable trigger user_roles_keep_one_admin;
delete from public.user_roles where user_id in (select (jsonb_array_elements_text(${idList}))::uuid);
alter table public.user_roles enable trigger user_roles_keep_one_admin;`);
  }
  let removed = 0;
  for (const id of ids) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (!error) removed++;
  }
  const [{ leftover }] = await db.query<{ leftover: number }>(
    "select count(*)::int as leftover from auth.users where id in (select (jsonb_array_elements_text($1::jsonb))::uuid)",
    [ids],
  );
  return { removed, leftover: Number(leftover) };
}

/** Removes any temporary users left behind by an interrupted earlier run. */
export async function sweepStaleTestUsers(db: Db, admin: SupabaseClient): Promise<number> {
  const stale = await db.query<{ id: string; email: string }>(
    "select id::text as id, email::text as email from auth.users where email like $1",
    [`%@${TEST_DOMAIN}`],
  );
  if (stale.length === 0) return 0;
  const users: TestUser[] = stale.map((s) => ({ id: s.id, email: s.email, password: "", role: null }));
  const { removed } = await removeTestUsers(db, admin, users);
  return removed;
}
