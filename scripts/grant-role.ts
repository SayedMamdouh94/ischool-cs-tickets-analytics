/**
 * Grants an application role to a user (bootstrap the first administrator).
 *
 *   npm run admin:grant -- --email you@example.com                 # user must already exist
 *   npm run admin:grant -- --email you@example.com --invite        # send a Supabase invite first
 *   npm run admin:grant -- --email analyst@example.com --role analyst
 *   npm run admin:grant -- --email old@example.com --revoke
 *
 * Uses DATABASE_URL (privileged) to write user_roles, and — only with
 * --invite — SUPABASE_SECRET_KEY to call the Auth admin API. Neither value is
 * ever printed.
 */
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { connect } from "./lib/db";
import { optionalEnv, requireEnv } from "./lib/env";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      role: { type: "string", default: "admin" },
      invite: { type: "boolean", default: false },
      revoke: { type: "boolean", default: false },
    },
  });
  const email = values.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("Usage: npm run admin:grant -- --email <address> [--role admin|analyst] [--invite] [--revoke]");
    return 1;
  }
  const role = values.role;
  if (role !== "admin" && role !== "analyst") {
    console.error("--role must be 'admin' or 'analyst'.");
    return 1;
  }

  const { sql, target } = connect({ max: 1 });
  try {
    let [user] = await sql<{ id: string }[]>`select id from auth.users where lower(email) = ${email} and deleted_at is null`;

    if (!user && values.invite) {
      const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
      const secret = requireEnv("SUPABASE_SECRET_KEY", "Required only for --invite. Keep it server-side.");
      const site = optionalEnv("NEXT_PUBLIC_SITE_URL") ?? "http://localhost:3000";
      const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${site}/auth/confirm?next=/account/password`,
      });
      if (error) {
        console.error(`Invite failed: ${error.message}`);
        return 1;
      }
      user = { id: data.user.id };
      console.log(`Invitation email sent to ${email}.`);
    }

    if (!user) {
      console.error(
        `No auth user with email ${email} in ${target}. Create it in Supabase (Authentication → Users → Add user), ` +
          "or re-run with --invite to send an invitation.",
      );
      return 1;
    }

    if (values.revoke) {
      await sql`delete from public.user_roles where user_id = ${user.id}`;
      console.log(`✓ Revoked application access for ${email}.`);
      return 0;
    }

    await sql`
      insert into public.user_roles (user_id, role) values (${user.id}, ${role})
      on conflict (user_id) do update set role = excluded.role
    `;
    await sql`
      insert into public.audit_events (user_id, action, details)
      values (null, 'access.role_granted', ${sql.json({ user_id: user.id, role, via: "cli" })})
    `;
    console.log(`✓ ${email} now has the '${role}' role.`);
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Aborted: ${(err as Error).message}`);
    process.exit(1);
  });
