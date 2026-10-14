/**
 * LOCAL DEVELOPMENT ONLY: creates an admin and an analyst user in the local
 * Supabase stack (`supabase start`) so the dashboard can be used immediately.
 * Refuses to run against any non-local Supabase URL.
 *
 *   npm run dev:users
 */
import { createClient } from "@supabase/supabase-js";
import { connect } from "./lib/db";
import { requireEnv } from "./lib/env";

export const LOCAL_USERS = [
  { email: "admin@local.test", password: "LocalAdmin#2026", role: "admin" },
  { email: "analyst@local.test", password: "LocalAnalyst#2026", role: "analyst" },
] as const;

async function main(): Promise<number> {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost"].includes(host)) {
    console.error("Refusing to seed users: NEXT_PUBLIC_SUPABASE_URL is not a local Supabase instance.");
    return 1;
  }
  const admin = createClient(url, requireEnv("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { sql } = connect({ max: 1 });
  try {
    if (!["127.0.0.1", "localhost"].includes(new URL(requireEnv("DATABASE_URL")).hostname)) {
      console.error("Refusing to seed users: DATABASE_URL is not local.");
      return 1;
    }
    for (const u of LOCAL_USERS) {
      let [existing] = await sql<{ id: string }[]>`select id from auth.users where email = ${u.email}`;
      if (!existing) {
        const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
        if (error) throw error;
        existing = { id: data.user.id };
      }
      await sql`
        insert into public.user_roles (user_id, role) values (${existing.id}, ${u.role})
        on conflict (user_id) do update set role = excluded.role
      `;
      console.log(`✓ ${u.email} (${u.role}) — password: ${u.password}`);
    }
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1]?.endsWith("seed-local-users.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`Aborted: ${(err as Error).message}`);
      process.exit(1);
    });
}
