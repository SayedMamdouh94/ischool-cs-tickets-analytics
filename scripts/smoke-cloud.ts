/**
 * Production permission smoke test through the real Supabase APIs.
 *
 *   ENV_FILE=.env.cloud npm run db:smoke
 *
 * Creates temporary admin / analyst / no-role accounts (random in-memory
 * passwords, reserved .invalid domain), verifies anonymous lockdown, disabled
 * sign-up, rejection of the local demo credentials, RLS and role checks,
 * per-project counts and audit logging, then removes the temporary accounts.
 * Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and
 * SUPABASE_SECRET_KEY; database access uses the configured transport.
 */
import { createClient } from "@supabase/supabase-js";
import { callRpc } from "@/lib/supabase/rpc";
import { BRIEF_EXPECTED_COUNTS } from "@/lib/ingest/default-projects";
import { connectDb } from "./lib/db";
import { requireEnv } from "./lib/env";
import { adminApi, createTestUsers, removeTestUsers, signIn, sweepStaleTestUsers, type TestUser } from "./lib/test-users";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });

async function main(): Promise<number> {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = adminApi(url, requireEnv("SUPABASE_SECRET_KEY"));
  const db = connectDb();
  console.log(`Smoke test against ${new URL(url).host} (database: ${db.target})\n`);
  let users: TestUser[] = [];

  try {
    const swept = await sweepStaleTestUsers(db, admin);
    if (swept) console.log(`Removed ${swept} temporary account(s) left by an earlier interrupted run.`);

    // ---- Anonymous ---------------------------------------------------------------
    const anon = createClient(url, key, { auth: { persistSession: false } });
    const anonTable = await anon.from("tickets").select("ticket_id").limit(1);
    check("anonymous: tickets table denied", anonTable.error?.code === "42501", anonTable.error?.code ?? "no error");
    const anonProjects = await anon.from("projects").select("code");
    check("anonymous: projects table denied", anonProjects.error?.code === "42501", anonProjects.error?.code ?? "no error");
    const anonRpc = await callRpc(anon, "get_grouped_metrics", { p_filters: {} });
    check("anonymous: analytics functions denied", Boolean(anonRpc.error), anonRpc.error?.code ?? "no error");
    const settings = (await (await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })).json()) as { disable_signup?: boolean };
    check("public sign-up disabled", settings.disable_signup === true, `disable_signup=${settings.disable_signup}`);
    const demo = await anon.auth.signInWithPassword({ email: "admin@local.test", password: "LocalAdmin#2026" });
    check("local demo admin credentials rejected", Boolean(demo.error), demo.error?.message ?? "demo login succeeded!");
    const demoAnalyst = await anon.auth.signInWithPassword({ email: "analyst@local.test", password: "LocalAnalyst#2026" });
    check("local demo analyst credentials rejected", Boolean(demoAnalyst.error), demoAnalyst.error?.message ?? "demo login succeeded!");

    // ---- Temporary accounts ---------------------------------------------------------
    users = await createTestUsers(db, admin, ["admin", "analyst", null], "smoke");
    const [adm, ana, none] = await Promise.all(users.map((u) => signIn(url, key, u)));

    // ---- No application role ----------------------------------------------------------
    const noneRows = await none.from("tickets").select("ticket_id").limit(5);
    check("no role: sees no ticket rows (RLS)", (noneRows.data ?? []).length === 0, `${noneRows.data?.length ?? 0} rows`);
    const noneProjects = await none.from("projects").select("code");
    check("no role: sees no projects (RLS)", (noneProjects.data ?? []).length === 0, `${noneProjects.data?.length ?? 0} rows`);
    const noneRpc = await callRpc(none, "get_grouped_metrics", { p_filters: {} });
    check("no role: analytics denied", noneRpc.error?.code === "42501", noneRpc.error?.code ?? "allowed!");

    // ---- Analyst -----------------------------------------------------------------------
    const m = await callRpc<{ rows: { key: string; tickets: number }[] }>(ana, "get_grouped_metrics", { p_filters: {}, p_dimension: "project" });
    const byProject = Object.fromEntries((m.data?.rows ?? []).map((r) => [r.key, r.tickets]));
    const total = Object.values(byProject).reduce((a, b) => a + b, 0);
    check("analyst: total tickets = 12,969", total === 12969, String(total));
    for (const [code, n] of Object.entries(BRIEF_EXPECTED_COUNTS)) check(`analyst: ${code} = ${n.toLocaleString("en-US")}`, byProject[code] === n, String(byProject[code]));
    const meta = await ana.from("tickets").select("ticket_id, topic, status").limit(3);
    check("analyst: ticket metadata readable", (meta.data ?? []).length === 3, meta.error?.code ?? "");
    for (const col of ["message", "note", "response", "attachment_urls"]) {
      const r = await ana.from("tickets").select(col).limit(1);
      check(`analyst: ${col} column denied`, r.error?.code === "42501", r.error?.code ?? "readable!");
    }
    const att = await ana.from("ticket_attachments").select("url").limit(1);
    check("analyst: attachments hidden (RLS)", (att.data ?? []).length === 0, `${att.data?.length ?? 0} rows`);
    const errs = await ana.from("import_errors").select("raw_row").limit(1);
    check("analyst: import error payloads hidden (RLS)", (errs.data ?? []).length === 0, `${errs.data?.length ?? 0} rows`);
    const [sample] = await db.query<{ ticket_id: number }>(
      "select ticket_id::bigint as ticket_id from public.tickets t where message is not null and exists (select 1 from public.ticket_attachments a where a.ticket_id = t.ticket_id) order by ticket_id limit 1",
    );
    const someId = Number(sample?.ticket_id);
    const det = await callRpc<{ content_visible: boolean; message: string | null; attachments: unknown }>(ana, "get_ticket_detail", { p_ticket_id: someId });
    check("analyst: ticket detail without content", det.data?.content_visible === false && det.data?.message === null && det.data?.attachments === null);
    const search = await callRpc<{ content_search: boolean }>(ana, "search_tickets", { p_filters: {}, p_search: "غياب" });
    check("analyst: no message-text search", search.data?.content_search === false);
    const exp = await callRpc(ana, "export_tickets_page", { p_filters: {} });
    check("analyst: ticket export denied", exp.error?.code === "42501", exp.error?.code ?? "allowed!");
    const thr = await callRpc(ana, "update_threshold", { p_key: "response_hours", p_value_hours: 1 });
    check("analyst: settings change denied", thr.error?.code === "42501", thr.error?.code ?? "allowed!");
    const roleGrab = await ana.from("user_roles").insert({ user_id: users[1].id, role: "admin" });
    check("analyst: cannot self-promote", Boolean(roleGrab.error), roleGrab.error?.code ?? "inserted!");

    // ---- Administrator -------------------------------------------------------------------
    const adet = await callRpc<{ content_visible: boolean; message: string | null; attachments: unknown[] }>(adm, "get_ticket_detail", { p_ticket_id: someId });
    check("admin: ticket content visible", adet.data?.content_visible === true && Boolean(adet.data?.message) && (adet.data?.attachments ?? []).length > 0);
    const [audit] = await db.query<{ n: number }>(
      "select count(*)::int as n from public.audit_events where user_id = $1::uuid and action = 'ticket.view_content' and details->>'ticket_id' = $2",
      [users[0].id, String(someId)],
    );
    check("admin: content view recorded in audit log", Number(audit.n) === 1, `${audit.n} event(s)`);
    const page = await callRpc<unknown[]>(adm, "export_tickets_page", { p_filters: {}, p_limit: 10 });
    check("admin: ticket export allowed", Array.isArray(page.data) && page.data.length === 10, page.error?.message ?? "");
    const dq = await callRpc<{ total: number }>(adm, "get_data_quality", { p_filters: {} });
    check("admin: data quality total = 12,969", dq.data?.total === 12969, String(dq.data?.total));
    const appUsers = await callRpc<unknown[]>(adm, "list_app_users");
    check("admin: access management available", Array.isArray(appUsers.data), appUsers.error?.message ?? "");
  } catch (err) {
    check("smoke test completed", false, (err as Error).message);
  } finally {
    if (users.some((u) => u.id)) {
      const { removed, leftover } = await removeTestUsers(db, admin, users).catch((e) => {
        check("cleanup", false, (e as Error).message);
        return { removed: 0, leftover: -1 };
      });
      check("cleanup: temporary accounts removed", leftover === 0, `${removed} removed, ${leftover} left`);
    }
    await db.end();
  }

  for (const r of results) console.log(`${r.pass ? "✓ PASS" : "✗ FAIL"}  ${r.name.padEnd(46)} ${r.detail}`);
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
