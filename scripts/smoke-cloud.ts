/**
 * Production smoke test of authentication, RLS and analytics through the real
 * Supabase API (not a privileged connection).
 *
 *   ENV_FILE=.env.production.local npm run db:smoke
 *
 * Creates two TEMPORARY users (admin + analyst) with random passwords that
 * exist only in this process, runs the checks, then deletes both users and
 * their audit entries. Requires NEXT_PUBLIC_SUPABASE_URL,
 * NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY and DATABASE_URL.
 */
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { callRpc } from "@/lib/supabase/rpc";
import { BRIEF_EXPECTED_COUNTS } from "@/lib/ingest/default-projects";
import { connect } from "./lib/db";
import { requireEnv } from "./lib/env";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });

function password(): string {
  // Meets the 12+ chars / upper / lower / digit policy; never printed.
  return `Sm0ke-${randomBytes(18).toString("base64url")}aA1`;
}

async function signIn(url: string, key: string, email: string, pw: string): Promise<SupabaseClient> {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: pw });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

async function main(): Promise<number> {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const secret = requireEnv("SUPABASE_SECRET_KEY");
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const { sql, target } = connect({ max: 1 });
  const stamp = `${Date.now()}`;
  const users = [
    { email: `smoke-admin-${stamp}@cs-analytics.invalid`, role: "admin" as const, pw: password(), id: "" },
    { email: `smoke-analyst-${stamp}@cs-analytics.invalid`, role: "analyst" as const, pw: password(), id: "" },
    { email: `smoke-norole-${stamp}@cs-analytics.invalid`, role: null, pw: password(), id: "" },
  ];
  console.log(`Smoke test against ${new URL(url).host} (database ${target})\n`);

  const [{ admins }] = await sql<{ admins: number }[]>`select count(*)::int as admins from public.user_roles where role = 'admin'`;
  if (admins === 0) {
    await sql.end({ timeout: 5 });
    console.error("No administrator exists yet. Grant the first real administrator (npm run admin:grant) before running the smoke test.");
    return 1;
  }

  try {
    // ---- Anonymous access -------------------------------------------------
    const anon = createClient(url, key, { auth: { persistSession: false } });
    const anonTable = await anon.from("tickets").select("ticket_id").limit(1);
    check("anonymous: tickets table denied", anonTable.error?.code === "42501", anonTable.error?.code ?? "no error");
    const anonRpc = await callRpc(anon, "get_grouped_metrics", { p_filters: {} });
    check("anonymous: analytics functions denied", Boolean(anonRpc.error), anonRpc.error?.code ?? "no error");
    // Read the Auth service's own setting (a sign-up probe can be rejected for unrelated
    // reasons, e.g. Supabase Cloud refuses reserved test domains).
    const settings = (await (await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })).json()) as { disable_signup?: boolean };
    check("public sign-up disabled", settings.disable_signup === true, `disable_signup=${settings.disable_signup}`);

    // Demo credentials from local development must not work here.
    const demo = await anon.auth.signInWithPassword({ email: "admin@local.test", password: "LocalAdmin#2026" });
    check("local demo admin credentials rejected", Boolean(demo.error), demo.error?.message ?? "demo login succeeded!");

    // ---- Temporary users ----------------------------------------------------
    for (const u of users) {
      const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.pw, email_confirm: true });
      if (error) throw new Error(`could not create temporary user: ${error.message}`);
      u.id = data.user.id;
      if (u.role) await sql`insert into public.user_roles (user_id, role) values (${u.id}, ${u.role})`;
    }
    const [adm, ana, none] = await Promise.all(users.map((u) => signIn(url, key, u.email, u.pw)));

    // ---- No role ---------------------------------------------------------------
    const noneRows = await none.from("tickets").select("ticket_id").limit(5);
    check("no role: sees no ticket rows", (noneRows.data ?? []).length === 0, `${noneRows.data?.length ?? 0} rows`);
    const noneRpc = await callRpc(none, "get_grouped_metrics", { p_filters: {} });
    check("no role: analytics denied", noneRpc.error?.code === "42501", noneRpc.error?.code ?? "allowed!");

    // ---- Analyst -----------------------------------------------------------------
    const m = await callRpc<{ rows: { key: string; tickets: number }[] }>(ana, "get_grouped_metrics", { p_filters: {}, p_dimension: "project" });
    const byProject = Object.fromEntries((m.data?.rows ?? []).map((r) => [r.key, r.tickets]));
    const total = Object.values(byProject).reduce((a, b) => a + b, 0);
    check("analyst: total tickets = 12,969", total === 12969, String(total));
    for (const [code, n] of Object.entries(BRIEF_EXPECTED_COUNTS)) check(`analyst: ${code} = ${n}`, byProject[code] === n, String(byProject[code]));
    const msg = await ana.from("tickets").select("message").limit(1);
    check("analyst: message column denied", msg.error?.code === "42501", msg.error?.code ?? "readable!");
    const att = await ana.from("ticket_attachments").select("url").limit(1);
    check("analyst: attachments hidden", (att.data ?? []).length === 0, `${att.data?.length ?? 0} rows`);
    const [{ some_id }] = await sql<{ some_id: number }[]>`select ticket_id as some_id from public.tickets where message is not null order by ticket_id limit 1`;
    const det = await callRpc<{ content_visible: boolean; message: string | null }>(ana, "get_ticket_detail", { p_ticket_id: some_id });
    check("analyst: ticket detail without content", det.data?.content_visible === false && det.data?.message === null);
    const exp = await callRpc(ana, "export_tickets_page", { p_filters: {} });
    check("analyst: ticket export denied", exp.error?.code === "42501", exp.error?.code ?? "allowed!");
    const thr = await callRpc(ana, "update_threshold", { p_key: "response_hours", p_value_hours: 1 });
    check("analyst: settings change denied", thr.error?.code === "42501", thr.error?.code ?? "allowed!");

    // ---- Admin ---------------------------------------------------------------------
    const adet = await callRpc<{ content_visible: boolean; message: string | null }>(adm, "get_ticket_detail", { p_ticket_id: some_id });
    check("admin: ticket content visible", adet.data?.content_visible === true && Boolean(adet.data?.message));
    const page = await callRpc<unknown[]>(adm, "export_tickets_page", { p_filters: {}, p_limit: 10 });
    check("admin: export allowed", Array.isArray(page.data) && page.data.length === 10, page.error?.message ?? "");
    const dq = await callRpc<{ total: number }>(adm, "get_data_quality", { p_filters: {} });
    check("admin: data quality total = 12,969", dq.data?.total === 12969, String(dq.data?.total));
  } catch (err) {
    check("smoke test completed", false, (err as Error).message);
  } finally {
    // ---- Cleanup: remove temporary users and anything they generated ---------------
    const ids = users.map((u) => u.id).filter(Boolean);
    if (ids.length) {
      await sql`delete from public.audit_events where user_id = any(${ids}::uuid[])`;
      await sql`delete from public.user_roles where user_id = any(${ids}::uuid[]) and role = 'analyst'`;
      // The admin row can only go while another admin exists (last-admin protection).
      await sql`delete from public.user_roles where user_id = any(${ids}::uuid[])`.catch((e) =>
        check("cleanup: temporary admin role removed", false, (e as Error).message),
      );
      for (const id of ids) {
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) check("cleanup: temporary user deleted", false, error.message);
      }
      const [{ left }] = await sql<{ left: number }[]>`select count(*)::int as left from auth.users where email like ${`smoke-%-${stamp}@cs-analytics.invalid`}`;
      check("cleanup: temporary users removed", left === 0, `${left} left`);
    }
    await sql.end({ timeout: 5 });
  }

  for (const r of results) console.log(`${r.pass ? "✓ PASS" : "✗ FAIL"}  ${r.name.padEnd(44)} ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length} checks, ${failed} failed.`);
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Smoke test aborted: ${(err as Error).message}`);
    process.exit(1);
  });
