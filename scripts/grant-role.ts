/**
 * Grants an application role to a user (provision administrators/analysts).
 *
 *   npm run admin:grant -- --email you@example.com                 # user must already exist
 *   npm run admin:grant -- --email you@example.com --invite        # send a Supabase invitation first
 *   npm run admin:grant -- --email analyst@example.com --role analyst
 *   npm run admin:grant -- --email old@example.com --revoke
 *
 * --email defaults to ADMIN_EMAIL when set. Uses the configured database
 * transport (DATABASE_URL or the passwordless Supabase CLI transport) and —
 * only with --invite — SUPABASE_SECRET_KEY for the Auth admin API. Idempotent.
 */
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { connectDb } from "./lib/db";
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
  const email = (values.email ?? optionalEnv("ADMIN_EMAIL"))?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("Usage: npm run admin:grant -- --email <address> [--role admin|analyst] [--invite] [--revoke]  (or set ADMIN_EMAIL)");
    return 1;
  }
  const role = values.role;
  if (role !== "admin" && role !== "analyst") {
    console.error("--role must be 'admin' or 'analyst'.");
    return 1;
  }

  const db = connectDb();
  try {
    let [user] = await db.query<{ id: string }>("select id::text as id from auth.users where lower(email) = $1 and deleted_at is null", [email]);

    if (!user && values.invite) {
      const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
      const secret = requireEnv("SUPABASE_SECRET_KEY", "Required only for --invite. Keep it server-side.");
      const site = optionalEnv("NEXT_PUBLIC_SITE_URL") ?? "http://localhost:3000";
      const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: `${site}/auth/callback?next=/account/password` });
      if (error) {
        console.error(`Invite failed: ${error.message}`);
        return 1;
      }
      user = { id: data.user.id };
      console.log(`Invitation email sent to ${email}.`);
    }

    if (!user) {
      console.error(`No auth user with email ${email} in ${db.target}. Re-run with --invite to send an invitation.`);
      return 1;
    }

    if (values.revoke) {
      await db.query("delete from public.user_roles where user_id = $1::uuid", [user.id]);
      console.log(`✓ Revoked application access for ${email}.`);
      return 0;
    }

    const [current] = await db.query<{ role: string }>("select role from public.user_roles where user_id = $1::uuid", [user.id]);
    if (current?.role === role) {
      console.log(`✓ ${email} already has the '${role}' role (no change).`);
      return 0;
    }
    await db.query(
      "insert into public.user_roles (user_id, role) values ($1::uuid, $2) on conflict (user_id) do update set role = excluded.role",
      [user.id, role],
    );
    await db.query("insert into public.audit_events (user_id, action, details) values (null, 'access.role_granted', $1::jsonb)", [
      { user_id: user.id, role, via: "cli" },
    ]);
    const [check] = await db.query<{ role: string }>("select role from public.user_roles where user_id = $1::uuid", [user.id]);
    console.log(`✓ ${email} now has the '${check?.role}' role (verified in the database).`);
    return check?.role === role ? 0 : 1;
  } finally {
    await db.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Aborted: ${(err as Error).message}`);
    process.exit(1);
  });
