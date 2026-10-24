/**
 * Database health and security checks.
 *
 *   npm run db:check
 *
 * Verifies migrations, Row Level Security, that anonymous users have no
 * access, that sensitive ticket columns are not directly readable, reference
 * data, and import status. Exits non-zero on any failure.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { connectDb } from "./lib/db";

type Level = "PASS" | "FAIL" | "WARN";
const results: { level: Level; name: string; detail: string }[] = [];
const ok = (name: string, pass: boolean, detail: string, warnOnly = false) =>
  results.push({ level: pass ? "PASS" : warnOnly ? "WARN" : "FAIL", name, detail });

const SENSITIVE_TICKET_COLUMNS = ["message", "response", "note", "attachment_urls", "response_attachment_urls"];

async function main(): Promise<number> {
  const db = connectDb();
  const isLocal = db.isLocal;
  console.log(`Checking ${db.target} [${db.kind}]${isLocal ? " [LOCAL]" : ""}\n`);
  try {
    const [{ version }] = await db.query<{ version: string }>(`select current_setting('server_version') as version`);
    ok("database reachable", true, `PostgreSQL ${version}`);

    // Migrations
    const localVersions = readdirSync(path.resolve("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0])
      .sort();
    let applied: string[] = [];
    try {
      applied = (await db.query<{ version: string }>(`select version::text as version from supabase_migrations.schema_migrations order by version`)).map((r) => r.version);
    } catch {
      applied = [];
    }
    const missing = localVersions.filter((v) => !applied.includes(v));
    ok("migrations applied", missing.length === 0, missing.length === 0 ? `${localVersions.length} of ${localVersions.length}` : `not applied: ${missing.join(", ")}`);

    // RLS on every public table
    const tables = await db.query<{ relname: string; relrowsecurity: boolean }>(`
      select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by 1
    `);
    const noRls = tables.filter((t) => !t.relrowsecurity).map((t) => t.relname);
    ok("RLS enabled on all public tables", noRls.length === 0, noRls.length === 0 ? `${tables.length} tables` : `missing: ${noRls.join(", ")}`);

    // anon has no table privileges
    const anonTables = await db.query<{ relname: string }>(`
      select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
        and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
          or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))
    `);
    ok("anon has no table privileges", anonTables.length === 0, anonTables.length === 0 ? "none" : anonTables.map((t) => t.relname).join(", "));

    // anon cannot execute any public function
    const anonFns = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
    `);
    ok("anon cannot execute public functions", anonFns.length === 0, anonFns.length === 0 ? "none" : anonFns.map((f) => f.proname).join(", "));

    // Sensitive columns are not directly selectable by authenticated users
    const exposed: string[] = [];
    for (const col of SENSITIVE_TICKET_COLUMNS) {
      const [{ allowed }] = await db.query<{ allowed: boolean }>(`select has_column_privilege('authenticated', 'public.tickets', $1, 'select') as allowed`, [col]);
      if (allowed) exposed.push(col);
    }
    ok("free-text ticket columns not directly readable", exposed.length === 0, exposed.length === 0 ? SENSITIVE_TICKET_COLUMNS.join(", ") : `exposed: ${exposed.join(", ")}`);

    // Every public function is SECURITY DEFINER with a pinned search_path and checks the role
    // Trigger / event-trigger functions (e.g. Supabase's platform-provided rls_auto_enable)
    // cannot be called through the Data API, so they are listed but not role-checked.
    const platformFns = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prorettype in ('trigger'::regtype, 'event_trigger'::regtype)
    `);
    if (platformFns.length > 0) {
      ok("trigger-only functions in public (not callable via API)", true, platformFns.map((f) => f.proname).join(", "));
    }
    const fns = await db.query<{ proname: string; prosecdef: boolean; config: string[] | null; src: string }>(`
      select p.proname, p.prosecdef, p.proconfig as config, p.prosrc as src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
    `);
    const unpinned = fns.filter((f) => !(f.config ?? []).some((c) => c.startsWith("search_path="))).map((f) => f.proname);
    ok("public functions pin search_path", unpinned.length === 0, unpinned.length === 0 ? `${fns.length} functions` : unpinned.join(", "));
    const unguarded = fns.filter((f) => f.proname !== "get_my_access" && !/require_(role|service_role)\(/.test(f.src)).map((f) => f.proname);
    ok("public functions enforce an application role", unguarded.length === 0, unguarded.length === 0 ? "all guarded" : unguarded.join(", "));

    // Import worker functions: service role only (never callable by signed-in users).
    const workerFns = await db.query<{ proname: string; auth_exec: boolean }>(`
      select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'worker\\_%'
    `);
    const exposedWorkers = workerFns.filter((f) => f.auth_exec).map((f) => f.proname);
    ok("import worker functions are service-role only", workerFns.length > 0 && exposedWorkers.length === 0,
      exposedWorkers.length === 0 ? `${workerFns.length} functions` : `executable by authenticated: ${exposedWorkers.join(", ")}`);

    // Staged rows (student text) have no client privileges at all.
    const [{ staged_exposed }] = await db.query<{ staged_exposed: boolean }>(`
      select has_table_privilege('authenticated', 'public.import_job_rows', 'select')
          or has_table_privilege('anon', 'public.import_job_rows', 'select') as staged_exposed
    `);
    ok("staged import rows not readable by clients", !staged_exposed, staged_exposed ? "exposed" : "no grants");

    // Uploaded exports live in a private bucket.
    const buckets = await db.query<{ public: boolean; file_size_limit: number | null }>(`select public, file_size_limit from storage.buckets where id = 'imports'`);
    ok("imports bucket exists and is private", buckets.length === 1 && !buckets[0].public,
      buckets.length === 0 ? "missing" : `public=${buckets[0].public}, limit ${buckets[0].file_size_limit ?? "none"} bytes`);

    // Background driver for confirmed imports.
    let cronOk = false;
    let cronDetail = "pg_cron not installed";
    try {
      const jobs = await db.query<{ schedule: string; active: boolean }>(`select schedule, active from cron.job where jobname = 'cs-tickets-import-jobs'`);
      cronOk = jobs.length === 1 && jobs[0].active;
      cronDetail = jobs.length === 0 ? "job not scheduled" : `every ${jobs[0].schedule}${jobs[0].active ? "" : " (inactive)"}`;
      const [recent] = await db.query<{ failed: number; total: number }>(`
        select count(*) filter (where status = 'failed')::int as failed, count(*)::int as total
        from cron.job_run_details d join cron.job j on j.jobid = d.jobid
        where j.jobname = 'cs-tickets-import-jobs' and d.start_time > now() - interval '1 hour'`);
      if (recent) cronDetail += ` — last hour: ${recent.total} runs, ${recent.failed} failed`;
      if (recent && recent.failed > 0) cronOk = false;
    } catch {
      cronOk = false;
    }
    ok("import scheduler (pg_cron) active", cronOk, cronDetail);

    let workerUrl = false;
    try {
      const [v] = await db.query<{ n: number }>(`select count(*)::int as n from vault.decrypted_secrets where name in ('import_worker_url', 'import_worker_secret')`);
      workerUrl = Number(v?.n ?? 0) === 2;
    } catch {
      workerUrl = false;
    }
    ok("validation watchdog can reach the web worker", workerUrl || isLocal,
      workerUrl ? "worker URL and secret configured in Vault" : "not configured — validation continues while the import page is open; run npm run worker:configure", true);

    // Reference data
    const [{ projects, active }] = await db.query<{ projects: number; active: number }>(
      `select count(*)::int as projects, count(*) filter (where status = 'active')::int as active from public.projects`,
    );
    ok("projects configured", projects >= 1, `${projects} projects (${active} active)`);
    const [{ current }] = await db.query<{ current: number }>(`select count(*)::int as current from public.reporting_cycles where is_current`);
    ok("a current reporting cycle is selected", current === 1, current === 1 ? "yes" : "none — the dashboard shows an empty scope", true);
    const [{ categories }] = await db.query<{ categories: number }>(`select count(*)::int as categories from public.ticket_categories`);
    ok("categories configured", categories > 0, `${categories} categories/subcategories`);
    const [{ thresholds }] = await db.query<{ thresholds: number }>(`select count(*)::int as thresholds from public.analytics_thresholds`);
    ok("analytics thresholds configured", thresholds === 2, `${thresholds} thresholds`);

    // Data
    const perProject = await db.query<{ code: string; n: number }>(`
      select p.code, count(t.id)::int as n from public.projects p
      left join public.tickets t on t.project_id = p.id group by p.code, p.display_order order by p.display_order
    `);
    const total = perProject.reduce((a, b) => a + b.n, 0);
    ok("tickets imported", total > 0, `${total} total — ${perProject.map((p) => `${p.code} ${p.n}`).join(", ")}`, true);
    const [{ unclassified }] = await db.query<{ unclassified: number }>(`
      select count(*)::int as unclassified from public.tickets t
      where not exists (select 1 from public.ticket_classifications c where c.ticket_pk = t.id and c.is_current)
    `);
    ok("every ticket has a current classification", unclassified === 0, `${unclassified} unclassified`, true);
    const [{ running, failed }] = await db.query<{ running: number; failed: number }>(`
      select count(*) filter (where status = 'running' and (source = 'cli' or started_at < now() - interval '6 hours'))::int as running,
             count(*) filter (where status = 'failed')::int as failed
        from public.import_runs
    `);
    ok("no import stuck in 'running'", running === 0, `${running} running`);
    const [{ stalled }] = await db.query<{ stalled: number }>(`
      select count(*)::int as stalled from public.import_jobs
      where status in ('uploaded', 'validating', 'importing') and coalesce(lease_expires_at, updated_at) < now() - interval '15 minutes'`);
    ok("no stalled web import jobs", stalled === 0, `${stalled} stalled`, true);
    ok("no failed imports in history", failed === 0, `${failed} failed`, true);

    // Demo / test accounts must never exist outside the local stack.
    const demo = await db.query<{ email: string; role: string | null }>(`
      select u.email::text as email, ur.role
      from auth.users u left join public.user_roles ur on ur.user_id = u.id
      where u.email ilike '%@local.test'
    `);
    ok(
      "no demo (@local.test) accounts",
      isLocal || demo.length === 0,
      demo.length === 0 ? "none" : `${demo.length} found${isLocal ? " (local stack — expected)" : ": " + demo.map((d) => d.email).join(", ")}`,
    );

    // Access
    const [{ admins }] = await db.query<{ admins: number }>(`select count(*)::int as admins from public.user_roles where role = 'admin'`);
    ok("at least one administrator assigned", admins > 0, admins > 0 ? `${admins} admin(s)` : "none — run: npm run admin:grant -- --email <you@example.com>", true);
  } finally {
    await db.end();
  }

  for (const r of results) {
    const icon = r.level === "PASS" ? "✓" : r.level === "FAIL" ? "✗" : "!";
    console.log(`${icon} ${r.level.padEnd(4)} ${r.name.padEnd(48)} ${r.detail}`);
  }
  const failed = results.filter((r) => r.level === "FAIL").length;
  console.log(`\n${results.length} checks, ${failed} failed.`);
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Check aborted: ${(err as Error).message}`);
    process.exit(1);
  });
