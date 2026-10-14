/**
 * READ-ONLY inspection of a target database before applying migrations.
 *
 *   ENV_FILE=.env.cloud npm run db:preflight
 *
 * Reports what already exists (tables with row counts, migration history,
 * auth users) and classifies the target as empty / this app / foreign so that
 * migrations are never applied blindly. Issues SELECT statements only.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { connectDb } from "./lib/db";

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
const IDENT = /^[a-z_][a-z0-9_]*$/;

async function main(): Promise<number> {
  const db = connectDb();
  console.log(`Preflight (read-only) against ${db.target}${db.isLocal ? " [LOCAL]" : ""}\n`);
  try {
    const [{ version }] = await db.query<{ version: string }>("select current_setting('server_version') as version");
    console.log(`PostgreSQL ${version}`);

    const tables = await db.query<{ schema: string; name: string }>(
      `select n.nspname as schema, c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname in ('public', 'private')
        order by 1, 2`,
    );
    const counts: Record<string, number> = {};
    for (const t of tables) {
      if (!IDENT.test(t.schema) || !IDENT.test(t.name)) continue;
      const [{ n }] = await db.query<{ n: number }>(`select count(*)::int as n from "${t.schema}"."${t.name}"`);
      counts[`${t.schema}.${t.name}`] = Number(n);
    }

    const [{ has_history }] = await db.query<{ has_history: boolean }>(
      "select to_regclass('supabase_migrations.schema_migrations') is not null as has_history",
    );
    const applied = has_history
      ? (await db.query<{ version: string }>("select version::text as version from supabase_migrations.schema_migrations order by version")).map((r) => r.version)
      : [];
    const local = readdirSync(path.resolve("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0])
      .sort();
    const [{ users, demo }] = await db.query<{ users: number; demo: number }>(
      "select count(*)::int as users, count(*) filter (where email ilike '%@local.test')::int as demo from auth.users",
    );

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
    if (Number(demo) > 0 && !db.isLocal) {
      verdict += " WARNING: demo @local.test accounts exist on a non-local database.";
      ok = false;
    }
    console.log(`\nVerdict: ${verdict}`);
    return ok ? 0 : 2;
  } finally {
    await db.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Preflight aborted: ${(err as Error).message}`);
    process.exit(1);
  });
