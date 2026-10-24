/**
 * Connects the database scheduler to the web import worker.
 *
 *   ENV_FILE=.env.cloud npm run worker:configure -- [--vercel] [--rotate] [--verify] [--url <worker url>]
 *
 * pg_cron applies confirmed imports by itself. File validation, however, runs
 * in the web app (it needs the spreadsheet parsers), so when no browser tab is
 * open the scheduler nudges POST /api/imports/worker. That endpoint requires a
 * shared bearer secret which this script:
 *
 *   1. generates (or reuses; --rotate makes a new one),
 *   2. stores in Supabase Vault together with the worker URL (read by pg_cron),
 *   3. with --vercel, stores as IMPORT_WORKER_SECRET in the Vercel production
 *      environment (takes effect on the next deployment),
 *   4. with --verify, calls the deployed worker endpoint to confirm it accepts it.
 *
 * The secret is never printed, logged or written to a file.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { connectDb } from "./lib/db";
import { requireEnv } from "./lib/env";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      vercel: { type: "boolean", default: false },
      rotate: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
    },
  });
  const url = values.url ?? `${requireEnv("NEXT_PUBLIC_SITE_URL").replace(/\/$/, "")}/api/imports/worker`;
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(url)) throw new Error(`Refusing a non-HTTPS worker URL: ${url}`);

  const db = connectDb();
  console.log(`Configuring the import worker for ${db.target}\n  worker URL: ${url}`);
  try {
    const existing = await db.query<{ id: string; name: string; secret: string }>(
      `select id::text as id, name, decrypted_secret as secret from vault.decrypted_secrets where name in ('import_worker_url', 'import_worker_secret')`,
    );
    const current = existing.find((s) => s.name === "import_worker_secret");
    const secret = !values.rotate && current?.secret && current.secret.length >= 32 ? current.secret : randomBytes(36).toString("base64url");
    const reused = secret === current?.secret;

    for (const [name, value, description] of [
      ["import_worker_url", url, "CS Tickets Analytics: web import worker endpoint (pg_cron watchdog)"],
      ["import_worker_secret", secret, "CS Tickets Analytics: bearer secret for the import worker endpoint"],
    ] as const) {
      const row = existing.find((s) => s.name === name);
      if (row) await db.query(`select vault.update_secret($1::uuid, $2, $3, $4)`, [row.id, value, name, description]);
      else await db.query(`select vault.create_secret($1, $2, $3)`, [value, name, description]);
    }
    console.log(`✓ Vault: worker URL and ${reused ? "existing" : "new"} secret stored`);

    if (values.vercel) {
      spawnSync("vercel", ["env", "rm", "IMPORT_WORKER_SECRET", "production", "--yes"], { stdio: "ignore" });
      const add = spawnSync("vercel", ["env", "add", "IMPORT_WORKER_SECRET", "production", "--sensitive"], { input: secret, encoding: "utf8" });
      if (add.status !== 0) {
        console.error(`✗ Vercel: could not store IMPORT_WORKER_SECRET (${(add.stderr || add.stdout).replace(/\s+/g, " ").slice(0, 200)})`);
        return 1;
      }
      console.log("✓ Vercel: IMPORT_WORKER_SECRET stored for Production (active after the next deployment)");
    } else if (!reused) {
      console.log("! The secret changed: re-run with --vercel so the web app accepts it.");
    }

    if (values.verify) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ jobId: null }),
        signal: AbortSignal.timeout(30_000),
      });
      const wrong = await fetch(url, { method: "POST", headers: { Authorization: "Bearer not-the-secret" }, signal: AbortSignal.timeout(30_000) });
      const ok = res.status === 202 && wrong.status === 401;
      console.log(`${ok ? "✓" : "✗"} Worker endpoint: with secret → ${res.status} (expected 202), without → ${wrong.status} (expected 401)`);
      if (!ok) return 1;
    }
    return 0;
  } finally {
    await db.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`worker:configure aborted: ${(err as Error).message}`);
    process.exit(1);
  });
