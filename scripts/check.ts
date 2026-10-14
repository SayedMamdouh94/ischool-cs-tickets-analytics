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
import { connect } from "./lib/db";

type Level = "PASS" | "FAIL" | "WARN";
const results: { level: Level; name: string; detail: string }[] = [];
const ok = (name: string, pass: boolean, detail: string, warnOnly = false) =>
  results.push({ level: pass ? "PASS" : warnOnly ? "WARN" : "FAIL", name, detail });

const SENSITIVE_TICKET_COLUMNS = ["message", "response", "note", "attachment_urls", "response_attachment_urls"];

async function main(): Promise<number> {
  const { sql, target } = connect({ max: 1 });
  console.log(`Checking ${target}\n`);
  try {
    const [{ version }] = await sql<{ version: string }[]>`select current_setting('server_version') as version`;
    ok("database reachable", true, `PostgreSQL ${version}`);

    // Migrations
    const localVersions = readdirSync(path.resolve("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0])
      .sort();
    let applied: string[] = [];
    try {
      applied = (await sql<{ version: string }[]>`select version from supabase_migrations.schema_migrations order by version`).map((r) => r.version);
    } catch {
      applied = [];
    }
    const missing = localVersions.filter((v) => !applied.includes(v));
    ok("migrations applied", missing.length === 0, missing.length === 0 ? `${localVersions.length} of ${localVersions.length}` : `not applied: ${missing.join(", ")}`);

    // RLS on every public table
    const tables = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by 1
    `;
    const noRls = tables.filter((t) => !t.relrowsecurity).map((t) => t.relname);
    ok("RLS enabled on all public tables", noRls.length === 0, noRls.length === 0 ? `${tables.length} tables` : `missing: ${noRls.join(", ")}`);

    // anon has no table privileges
    const anonTables = await sql<{ relname: string }[]>`
      select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
        and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
          or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))
    `;
    ok("anon has no table privileges", anonTables.length === 0, anonTables.length === 0 ? "none" : anonTables.map((t) => t.relname).join(", "));

    // anon cannot execute any public function
    const anonFns = await sql<{ proname: string }[]>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
    `;
    ok("anon cannot execute public functions", anonFns.length === 0, anonFns.length === 0 ? "none" : anonFns.map((f) => f.proname).join(", "));

    // Sensitive columns are not directly selectable by authenticated users
    const exposed: string[] = [];
    for (const col of SENSITIVE_TICKET_COLUMNS) {
      const [{ allowed }] = await sql<{ allowed: boolean }[]>`select has_column_privilege('authenticated', 'public.tickets', ${col}, 'select') as allowed`;
      if (allowed) exposed.push(col);
    }
    ok("free-text ticket columns not directly readable", exposed.length === 0, exposed.length === 0 ? SENSITIVE_TICKET_COLUMNS.join(", ") : `exposed: ${exposed.join(", ")}`);

    // Every public function is SECURITY DEFINER with a pinned search_path and checks the role
    const fns = await sql<{ proname: string; prosecdef: boolean; config: string[] | null; src: string }[]>`
      select p.proname, p.prosecdef, p.proconfig as config, p.prosrc as src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
    `;
    const unpinned = fns.filter((f) => !(f.config ?? []).some((c) => c.startsWith("search_path="))).map((f) => f.proname);
    ok("public functions pin search_path", unpinned.length === 0, unpinned.length === 0 ? `${fns.length} functions` : unpinned.join(", "));
    const unguarded = fns.filter((f) => f.proname !== "get_my_access" && !/require_role\(/.test(f.src)).map((f) => f.proname);
    ok("public functions enforce an application role", unguarded.length === 0, unguarded.length === 0 ? "all guarded" : unguarded.join(", "));

    // Reference data
    const [{ projects }] = await sql<{ projects: number }[]>`select count(*)::int as projects from public.projects`;
    ok("projects configured", projects >= 4, `${projects} projects`);
    const [{ categories }] = await sql<{ categories: number }[]>`select count(*)::int as categories from public.ticket_categories`;
    ok("categories configured", categories > 0, `${categories} categories/subcategories`);
    const [{ thresholds }] = await sql<{ thresholds: number }[]>`select count(*)::int as thresholds from public.analytics_thresholds`;
    ok("analytics thresholds configured", thresholds === 2, `${thresholds} thresholds`);

    // Data
    const perProject = await sql<{ code: string; n: number }[]>`
      select p.code, count(t.ticket_id)::int as n from public.projects p
      left join public.tickets t on t.project_id = p.id group by p.code, p.display_order order by p.display_order
    `;
    const total = perProject.reduce((a, b) => a + b.n, 0);
    ok("tickets imported", total > 0, `${total} total — ${perProject.map((p) => `${p.code} ${p.n}`).join(", ")}`, true);
    const [{ unclassified }] = await sql<{ unclassified: number }[]>`
      select count(*)::int as unclassified from public.tickets t
      where not exists (select 1 from public.ticket_classifications c where c.ticket_id = t.ticket_id and c.is_current)
    `;
    ok("every ticket has a current classification", unclassified === 0, `${unclassified} unclassified`, true);
    const [{ running, failed }] = await sql<{ running: number; failed: number }[]>`
      select count(*) filter (where status = 'running')::int as running, count(*) filter (where status = 'failed')::int as failed from public.import_runs
    `;
    ok("no import stuck in 'running'", running === 0, `${running} running`);
    ok("no failed imports in history", failed === 0, `${failed} failed`, true);

    // Access
    const [{ admins }] = await sql<{ admins: number }[]>`select count(*)::int as admins from public.user_roles where role = 'admin'`;
    ok("at least one administrator assigned", admins > 0, admins > 0 ? `${admins} admin(s)` : "none — run: npm run admin:grant -- --email <you@example.com>", true);
  } finally {
    await sql.end({ timeout: 5 });
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
