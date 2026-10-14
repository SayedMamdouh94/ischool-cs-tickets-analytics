/**
 * READ-ONLY inspection of a target database before applying migrations.
 *
 *   ENV_FILE=.env.production.local npm run db:preflight
 *
 * Reports what already exists (schemas, tables with row counts, migration
 * history, auth users) and classifies the target as empty / this app / foreign
 * so that migrations are never applied blindly. Writes nothing.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { connect } from "./lib/db";

const APP_TABLES = [
  "projects",
  "tickets",
  "ticket_attachments",
  "import_runs",
  "import_errors",
  "ticket_categories",
  "ticket_classifications",
  "analytics_thresholds",
  "app_settings",
  "user_roles",
  "audit_events",
];

async function main(): Promise<number> {
  const { sql, target, isLocal } = connect({ max: 1 });
  console.log(`Preflight (read-only) against ${target}${isLocal ? " [LOCAL]" : ""}\n`);
  try {
    // Every statement in this session is read-only; any accidental write would fail.
    await sql`set session characteristics as transaction read only`;
    const [{ version }] = await sql<{ version: string }[]>`select current_setting('server_version') as version`;
    console.log(`PostgreSQL ${version}`);

    const tables = await sql<{ schema: string; name: string; est: number }[]>`
      select n.nspname as schema, c.relname as name, greatest(c.reltuples, 0)::bigint as est
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname in ('public', 'private')
      order by 1, 2
    `;
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(t.schema)}.${sql(t.name)}`;
      counts[`${t.schema}.${t.name}`] = n;
    }

    let applied: string[] = [];
    try {
      applied = (await sql<{ version: string }[]>`select version from supabase_migrations.schema_migrations order by version`).map((r) => r.version);
    } catch {
      applied = [];
    }
    const local = readdirSync(path.resolve("supabase/migrations")).filter((f) => f.endsWith(".sql")).map((f) => f.split("_")[0]).sort();
    const [{ users }] = await sql<{ users: number }[]>`select count(*)::int as users from auth.users`;
    const [{ demo }] = await sql<{ demo: number }[]>`select count(*)::int as demo from auth.users where email ilike '%@local.test'`;

    console.log(`\nTables in public/private (${tables.length}):`);
    if (tables.length === 0) console.log("  (none)");
    for (const t of tables) console.log(`  ${`${t.schema}.${t.name}`.padEnd(40)} ${String(counts[`${t.schema}.${t.name}`]).padStart(8)} rows`);
    console.log(`\nMigration history: ${applied.length ? applied.join(", ") : "(none)"}`);
    console.log(`Repository migrations: ${local.join(", ")}`);
    console.log(`Pending: ${local.filter((v) => !applied.includes(v)).join(", ") || "(none)"}`);
    const unknown = applied.filter((v) => !local.includes(v));
    if (unknown.length) console.log(`Applied remotely but NOT in this repository: ${unknown.join(", ")}`);
    console.log(`Auth users: ${users} (demo @local.test accounts: ${demo})`);

    const publicTables = tables.filter((t) => t.schema === "public").map((t) => t.name);
    const foreign = publicTables.filter((t) => !APP_TABLES.includes(t));
    const ours = publicTables.filter((t) => APP_TABLES.includes(t));
    let verdict: string;
    let ok = true;
    if (publicTables.length === 0 && applied.length === 0) {
      verdict = "EMPTY — safe to apply all migrations.";
    } else if (foreign.length === 0 && unknown.length === 0) {
      verdict = `THIS APP — ${ours.length} app tables present; only pending migrations would be applied.`;
    } else {
      verdict = `CONTAINS OTHER OBJECTS (${[...foreign, ...unknown].join(", ")}) — review before applying migrations.`;
      ok = false;
    }
    if (demo > 0 && !isLocal) {
      verdict += " WARNING: demo @local.test accounts exist on a non-local database.";
      ok = false;
    }
    console.log(`\nVerdict: ${verdict}`);
    return ok ? 0 : 2;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Preflight aborted: ${(err as Error).message}`);
    process.exit(1);
  });
