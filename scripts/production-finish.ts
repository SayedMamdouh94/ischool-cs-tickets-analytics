/**
 * One command to bring production to a verified state, safely and repeatably.
 *
 *   ENV_FILE=.env.cloud npm run production:finish
 *
 * Steps (each idempotent; nothing is reset, dropped or recreated):
 *   1. access      Supabase project reachable via the CLI login; site reachable
 *   2. auth        site URL, redirect allow-list, invite-only sign-up (only pushed if different)
 *   3. preflight   schema present and migrations up to date (read-only)
 *   4. import      CSVs in data/raw; files already imported cleanly are skipped
 *   5. validate    reconciliation checks against the original files (72)
 *   6. health      security and health checks
 *   7. admin       ADMIN_EMAIL gets the admin role (invited if new); skipped if unset
 *   8. permissions RLS / role smoke test with temporary accounts
 *   9. live        authenticated HTTP smoke test of every dashboard page
 *
 * Secrets stay in the environment / .env.cloud; nothing is written to reports.
 */
import { spawn } from "node:child_process";
import { connectDb } from "./lib/db";
import { optionalEnv, requireEnv } from "./lib/env";

type Status = "PASS" | "FAIL" | "SKIP";
const summary: { step: string; status: Status; detail: string }[] = [];

function run(script: string, args: string[] = []): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "--tsconfig", "tsconfig.json", `scripts/${script}`, ...args], { stdio: "inherit", env: process.env });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function step(name: string, fn: () => Promise<{ ok: boolean; detail?: string; skip?: boolean }>): Promise<boolean> {
  console.log(`\n━━━ ${name} ${"━".repeat(Math.max(0, 60 - name.length))}`);
  try {
    const r = await fn();
    summary.push({ step: name, status: r.skip ? "SKIP" : r.ok ? "PASS" : "FAIL", detail: r.detail ?? "" });
    return r.ok || Boolean(r.skip);
  } catch (err) {
    summary.push({ step: name, status: "FAIL", detail: (err as Error).message.slice(0, 160) });
    return false;
  }
}

async function main(): Promise<number> {
  const site = requireEnv("NEXT_PUBLIC_SITE_URL").replace(/\/$/, "");
  const adminEmail = optionalEnv("ADMIN_EMAIL");

  const foundation =
    (await step("1. access", async () => {
      const db = connectDb();
      try {
        const [{ v }] = await db.query<{ v: string }>("select current_setting('server_version') as v");
        const res = await fetch(`${site}/login`, { signal: AbortSignal.timeout(30_000) });
        return { ok: res.status === 200, detail: `${db.target}; PostgreSQL ${v}; site HTTP ${res.status}` };
      } finally {
        await db.end();
      }
    })) &&
    (await step("2. auth settings", async () => ({ ok: (await run("auth-config.ts", ["--apply"])) === 0 }))) &&
    (await step("3. preflight", async () => ({ ok: (await run("preflight.ts")) === 0 }))) &&
    (await step("4. import", async () => ({ ok: (await run("import.ts", ["--skip-known-files"])) === 0 })));

  if (foundation) {
    await step("5. validate (reconciliation)", async () => ({ ok: (await run("validate.ts")) === 0 }));
    await step("6. health checks", async () => ({ ok: (await run("check.ts")) === 0 }));
    await step("7. administrator", async () =>
      adminEmail
        ? { ok: (await run("grant-role.ts", ["--email", adminEmail, "--role", "admin", "--invite"])) === 0, detail: adminEmail }
        : { ok: false, skip: true, detail: "ADMIN_EMAIL not set — set it in .env.cloud to provision the administrator" },
    );
    await step("8. permissions smoke test", async () => ({ ok: (await run("smoke-cloud.ts")) === 0 }));
    await step("9. live dashboard smoke test", async () => ({ ok: (await run("web-smoke.ts", ["--url", site])) === 0 }));
  }

  console.log("\n━━━ production:finish summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const s of summary) console.log(`${s.status === "PASS" ? "✓" : s.status === "SKIP" ? "–" : "✗"} ${s.status.padEnd(4)} ${s.step.padEnd(30)} ${s.detail}`);
  const failed = summary.filter((s) => s.status === "FAIL").length;
  if (!foundation) console.log("\nStopped early: a foundational step failed.");
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`production:finish aborted: ${(err as Error).message}`);
    process.exit(1);
  });
