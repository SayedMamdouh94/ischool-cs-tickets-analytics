/**
 * Live dashboard smoke test over HTTP (no browser needed).
 *
 *   ENV_FILE=.env.cloud npm run web:smoke [-- --url https://...]
 *
 * Temporary admin / analyst / no-role accounts (random in-memory passwords,
 * removed afterwards) sign in through @supabase/ssr's own cookie encoding;
 * every dashboard page is then rendered server-side by the deployed app and
 * checked for HTTP status, real data, absence of error boundaries, filter and
 * export behaviour, role restrictions, security headers and leaked secrets.
 */
import { parseArgs } from "node:util";
import { createServerClient } from "@supabase/ssr";
import { connectDb, type Db } from "./lib/db";
import { optionalEnv, requireEnv } from "./lib/env";
import { adminApi, createTestUsers, removeTestUsers, sweepStaleTestUsers, type TestUser } from "./lib/test-users";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });
const fmt = (n: number) => n.toLocaleString("en-US");
const ERROR_MARKERS = ["This view could not be loaded", "Application error", "Internal Server Error"];

async function sessionCookie(url: string, key: string, u: TestUser): Promise<string> {
  const jar = new Map<string, string>();
  const client = createServerClient(url, key, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach((c) => (c.value ? jar.set(c.name, c.value) : jar.delete(c.name))),
    },
  });
  const { error } = await client.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  return [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
}

async function get(site: string, path: string, cookie?: string): Promise<{ status: number; text: string; location: string | null; headers: Headers }> {
  const res = await fetch(`${site}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual", signal: AbortSignal.timeout(90_000) });
  const text = res.status === 200 ? await res.text() : "";
  return { status: res.status, text, location: res.headers.get("location"), headers: res.headers };
}

async function expected(db: Db) {
  const [row] = await db.query<{ total: number; sept: number; deci_summer: number; demi3: number; sample: number }>(
    `select (select count(*)::int from public.tickets) as total,
            (select count(*)::int from public.tickets where created_date between '2026-09-01' and '2026-09-30') as sept,
            (select count(*)::int from public.tickets t join public.projects p on p.id = t.project_id where p.code = 'DECI_SUMMER') as deci_summer,
            (select count(*)::int from public.tickets t join public.projects p on p.id = t.project_id where p.code = 'DEMI_3RD') as demi3,
            (select ticket_id::bigint from public.tickets where message is not null order by ticket_id limit 1) as sample`,
  );
  return { total: Number(row.total), sept: Number(row.sept), deciSummer: Number(row.deci_summer), demi3: Number(row.demi3), sample: Number(row.sample) };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { url: { type: "string" } } });
  const site = (values.url ?? optionalEnv("NEXT_PUBLIC_SITE_URL") ?? "").replace(/\/$/, "");
  if (!/^https?:\/\//.test(site)) throw new Error("Provide --url or NEXT_PUBLIC_SITE_URL.");
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const secret = requireEnv("SUPABASE_SECRET_KEY");
  const admin = adminApi(url, secret);
  const db = connectDb();
  console.log(`Live smoke test of ${site}\n`);
  let users: TestUser[] = [];

  try {
    await sweepStaleTestUsers(db, admin);
    const exp = await expected(db);

    // ---- Anonymous ------------------------------------------------------------------
    const login = await get(site, "/login");
    check("anonymous: /login renders", login.status === 200 && login.text.includes("Sign in"), String(login.status));
    for (const h of ["x-frame-options", "content-security-policy", "x-content-type-options", "strict-transport-security", "referrer-policy"]) {
      check(`header ${h}`, Boolean(login.headers.get(h)), login.headers.get(h)?.slice(0, 40) ?? "missing");
    }
    const anonOverview = await get(site, "/overview");
    check("anonymous: dashboard redirects to login", [302, 303, 307, 308].includes(anonOverview.status) && (anonOverview.location ?? "").includes("/login"), `${anonOverview.status} → ${anonOverview.location}`);
    const anonExport = await get(site, "/api/export/tickets");
    check("anonymous: ticket export → 401", anonExport.status === 401, String(anonExport.status));

    // ---- Client bundle must not contain secrets ------------------------------------
    const chunks = [...new Set([...login.text.matchAll(/\/_next\/static\/[^"'\s)]+\.js/g)].map((m) => m[0]))];
    let leaked = 0;
    for (const c of chunks) {
      const js = await (await fetch(`${site}${c}`)).text();
      if (js.includes(secret) || /sb_secret_[A-Za-z0-9_-]{10,}/.test(js) || /postgres(ql)?:\/\/[^"'\s]+:[^"'\s]+@/.test(js)) leaked++;
    }
    check("client bundle free of secrets", leaked === 0 && chunks.length > 0, `${chunks.length} chunks scanned, ${leaked} with secrets`);

    // ---- Signed-in users ---------------------------------------------------------------
    users = await createTestUsers(db, admin, ["admin", "analyst", null], "websmoke");
    const [adminCookie, analystCookie, noneCookie] = await Promise.all(users.map((u) => sessionCookie(url, key, u)));

    const pages: [string, string[]][] = [
      ["/overview", ["Executive Overview", fmt(exp.total)]],
      ["/projects", ["Projects Comparison", "DEMI — 3rd Intake"]],
      ["/projects/DEMI_3RD", ["DEMI — 3rd Intake", fmt(exp.demi3)]],
      ["/trends", ["Ticket Trends", "When tickets are created"]],
      ["/topics", ["Topics &amp; Complaints", "Report a Problem / inquiry"]],
      ["/team", ["Support Team", "Responders"]],
      ["/backlog", ["Backlog &amp; Resolution", "Longest outstanding tickets"]],
      ["/tickets", ["Ticket Explorer", `of ${fmt(exp.total)} tickets`]],
      ["/data-quality", ["Data Quality", "File-level reconciliation"]],
      ["/insights", ["Insights &amp; Recommendations", "Method"]],
      ["/settings", ["Settings &amp; Imports", "Analytics thresholds"]],
      ["/reports/summary", ["Management Summary", "Headline figures"]],
    ];
    for (const [path, markers] of pages) {
      const r = await get(site, path, adminCookie);
      const missing = markers.filter((m) => !r.text.includes(m));
      const errors = ERROR_MARKERS.filter((m) => r.text.includes(m));
      check(`admin: ${path}`, r.status === 200 && missing.length === 0 && errors.length === 0, r.status !== 200 ? `HTTP ${r.status}` : missing.length ? `missing ${missing.join(" | ")}` : errors.length ? `error: ${errors[0]}` : "ok");
    }

    // Filters (KPIs must match SQL)
    const byProject = await get(site, "/overview?project=DECI_SUMMER", adminCookie);
    check("project filter: DECI Summer total matches SQL", byProject.text.includes(`>${fmt(exp.deciSummer)}<`), `expected ${fmt(exp.deciSummer)}`);
    const byDate = await get(site, "/overview?preset=custom&from=2026-09-01&to=2026-09-30", adminCookie);
    check("date filter: September 2026 total matches SQL", byDate.text.includes(`>${fmt(exp.sept)}<`), `expected ${fmt(exp.sept)}`);

    // Search and ticket detail
    const search = await get(site, `/tickets?q=${exp.sample}`, adminCookie);
    check("ticket search finds the ticket", search.text.includes(`#${exp.sample}`), `#${exp.sample}`);
    const detailAdmin = await get(site, `/tickets/${exp.sample}`, adminCookie);
    check("admin: ticket detail shows message", detailAdmin.status === 200 && detailAdmin.text.includes("Student message"), String(detailAdmin.status));
    const detailAnalyst = await get(site, `/tickets/${exp.sample}`, analystCookie);
    check("analyst: ticket detail hides content", detailAnalyst.status === 200 && detailAnalyst.text.includes("Message content hidden") && !detailAnalyst.text.includes("Student message"), String(detailAnalyst.status));
    const analystSettings = await get(site, "/settings", analystCookie);
    check("analyst: settings are read-only", analystSettings.text.includes("settings are read-only"));

    // Exports
    const adminCsv = await fetch(`${site}/api/export/tickets?project=DECI_SUMMER&include_text=0`, { headers: { cookie: adminCookie } });
    const csvLines = adminCsv.status === 200 ? (await adminCsv.text()).trim().split(/\r\n/).length : 0;
    check("admin: filtered ticket CSV export", adminCsv.status === 200 && csvLines === exp.deciSummer + 1, `${adminCsv.status}, ${csvLines - 1} rows`);
    const analystCsv = await fetch(`${site}/api/export/tickets`, { headers: { cookie: analystCookie } });
    check("analyst: ticket export blocked (403)", analystCsv.status === 403, String(analystCsv.status));
    const analystAgg = await fetch(`${site}/api/export/aggregate?dataset=projects`, { headers: { cookie: analystCookie } });
    check("analyst: aggregate export allowed", analystAgg.status === 200 && (await analystAgg.text()).includes("Project,Tickets"), String(analystAgg.status));

    // No application role
    const noneOverview = await get(site, "/overview", noneCookie);
    const noAccess = noneOverview.text.includes("/no-access") || (noneOverview.location ?? "").includes("/no-access");
    check("no role: redirected to /no-access, no data", noAccess && !noneOverview.text.includes(fmt(exp.total)), `${noneOverview.status}`);
    const noneAgg = await fetch(`${site}/api/export/aggregate?dataset=projects`, { headers: { cookie: noneCookie } });
    check("no role: aggregate export blocked (403)", noneAgg.status === 403, String(noneAgg.status));
  } catch (err) {
    check("web smoke test completed", false, (err as Error).message);
  } finally {
    if (users.some((u) => u.id)) {
      const { leftover } = await removeTestUsers(db, admin, users).catch(() => ({ leftover: -1 }));
      check("cleanup: temporary accounts removed", leftover === 0, `${leftover} left`);
    }
    await db.end();
  }

  for (const r of results) console.log(`${r.pass ? "✓ PASS" : "✗ FAIL"}  ${r.name.padEnd(48)} ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length} checks, ${failed} failed.`);
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Web smoke test aborted: ${(err as Error).message}`);
    process.exit(1);
  });
