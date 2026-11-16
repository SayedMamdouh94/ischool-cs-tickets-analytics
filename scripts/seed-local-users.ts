/**
 * LOCAL DEVELOPMENT ONLY: creates an admin, an analyst and a "Support Lead"
 * (custom role, DECI program only) in the local Supabase stack
 * (`supabase start`) so the dashboard and its permissions can be tried at once.
 * Refuses to run against any non-local Supabase URL.
 *
 *   npm run dev:users
 */
import { createClient } from "@supabase/supabase-js";
import { connect } from "./lib/db";
import { requireEnv } from "./lib/env";

/** Demo custom role: a few pages plus message text, no exports or settings. */
const SUPPORT_LEAD = {
  code: "support_lead",
  name: "Support Lead",
  description: "Demo role: overview, trends, topics, Ticket Explorer with message text. No exports or settings.",
  permissions: ["page.overview", "page.trends", "page.topics", "page.tickets", "tickets.read_content"],
};

export const LOCAL_USERS: { email: string; password: string; role: string; programs?: string[] }[] = [
  { email: "admin@local.test", password: "LocalAdmin#2026", role: "admin" },
  { email: "analyst@local.test", password: "LocalAnalyst#2026", role: "analyst" },
  { email: "lead@local.test", password: "LocalLead#2026", role: SUPPORT_LEAD.code, programs: ["DECI"] },
];

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
    await sql`
      insert into public.app_roles (code, name, description, permissions)
      values (${SUPPORT_LEAD.code}, ${SUPPORT_LEAD.name}, ${SUPPORT_LEAD.description}, ${SUPPORT_LEAD.permissions})
      on conflict (code) do nothing
    `;
    for (const u of LOCAL_USERS) {
      let [existing] = await sql<{ id: string }[]>`select id from auth.users where email = ${u.email}`;
      if (!existing) {
        const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
        if (error) throw error;
        existing = { id: data.user.id };
      }
      const allProjects = !u.programs?.length;
      await sql`
        insert into public.user_roles (user_id, role, all_projects) values (${existing.id}, ${u.role}, ${allProjects})
        on conflict (user_id) do update set role = excluded.role, all_projects = excluded.all_projects
      `;
      await sql`delete from public.user_program_access where user_id = ${existing.id}`;
      for (const program of u.programs ?? []) {
        await sql`insert into public.user_program_access (user_id, program) values (${existing.id}, ${program})`;
      }
      console.log(`✓ ${u.email} (${u.role}${allProjects ? "" : `, ${u.programs!.join(", ")} only`}) — password: ${u.password}`);
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
