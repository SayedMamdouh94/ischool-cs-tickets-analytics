import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SOURCE_COLUMNS, type SourceRow } from "@/lib/ingest/columns";
import { sql, stackReachable } from "./helpers";

const reachable = await stackReachable();
const ROOT = path.resolve(__dirname, "../..");

function csv(rows: Partial<SourceRow>[]): string {
  const base = Object.fromEntries(SOURCE_COLUMNS.map((c) => [c, ""])) as SourceRow;
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return [SOURCE_COLUMNS.join(","), ...rows.map((r) => SOURCE_COLUMNS.map((c) => esc({ ...base, ...r }[c])).join(","))].join("\n");
}

function runImport(file: string): string {
  return execFileSync("npx", ["tsx", "--tsconfig", "tsconfig.json", "scripts/import.ts", "--file", file], { cwd: ROOT, encoding: "utf8" });
}

/**
 * Exercises the real CLI importer against the local database with a crafted
 * export for DECI Summer (org 1906), then removes everything it created.
 */
describe.skipIf(!reachable)("CSV importer", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-import-"));
  const file = path.join(dir, "DECI Summer Intake Edu Tickets - integration.csv");
  const NEW_ID = 999_000_001;
  const db = sql();

  afterAll(async () => {
    await db`delete from public.tickets where ticket_id between 999000000 and 999000999`;
    await db`delete from public.import_runs where source_filename = ${path.basename(file)}`;
    await db.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects collisions, duplicates and invalid rows, and logs each one", async () => {
    // 407898 already belongs to DEMI_3RD (org 1609).
    const [{ before }] = await db<{ before: string }[]>`select row_hash as before from public.tickets where ticket_id = 407898`;
    writeFileSync(
      file,
      csv([
        { Ticket_ID: String(NEW_ID), Topic: "Report a Problem / inquiry", Status: "completed", Created_At: "2026-08-01 10:00:00 +0300", Resolved_At: "2026-08-02 10:00:00 +0300", Organization_ID: "1906", Message: "Details: integration test" },
        { Ticket_ID: String(NEW_ID), Topic: "Report a Problem / inquiry", Status: "pending", Created_At: "2026-08-01 10:00:00 +0300", Organization_ID: "1906" },
        { Ticket_ID: "407898", Topic: "Report a Problem / inquiry", Status: "completed", Created_At: "2026-08-01 10:00:00 +0300", Organization_ID: "1906" },
        { Ticket_ID: "999000002", Topic: "Report a Problem / inquiry", Status: "completed", Created_At: "not a date", Organization_ID: "1906" },
      ]),
    );
    const out = runImport(file);
    expect(out).toMatch(/completed_with_errors/);

    const [run] = await db<{ id: string; inserted_count: number; rejected_count: number; records_in_file: number }[]>`
      select id, inserted_count, rejected_count, records_in_file from public.import_runs
      where source_filename = ${path.basename(file)} order by started_at desc limit 1`;
    expect(run.records_in_file).toBe(4);
    expect(run.inserted_count).toBe(1);
    expect(run.rejected_count).toBe(3);

    const errors = await db<{ error_code: string; ticket_id: number | null }[]>`
      select error_code, ticket_id from public.import_errors where import_run_id = ${run.id} order by error_code`;
    expect(errors.map((e) => e.error_code)).toEqual(["DUPLICATE_TICKET_IN_FILE", "TICKET_ID_COLLISION", "VALIDATION_FAILED"]);

    // The other project's ticket was not touched.
    const [{ after, code }] = await db<{ after: string; code: string }[]>`
      select t.row_hash as after, p.code from public.tickets t join public.projects p on p.id = t.project_id where t.ticket_id = 407898`;
    expect(after).toBe(before);
    expect(code).toBe("DEMI_3RD");
  });

  it("is idempotent: re-importing the same file changes nothing", async () => {
    const out = runImport(file);
    expect(out).toMatch(/\+0 inserted, 0 updated, 1 unchanged/);
    const [{ n }] = await db<{ n: number }[]>`select count(*)::int as n from public.tickets where ticket_id = ${NEW_ID}`;
    expect(n).toBe(1);
  });

  it("applies newer exports and refuses to reassign a ticket to another project", async () => {
    writeFileSync(
      file,
      csv([
        { Ticket_ID: String(NEW_ID), Topic: "Report a Problem / inquiry", Status: "completed", Created_At: "2026-08-01 10:00:00 +0300", Resolved_At: "2026-08-03 10:00:00 +0300", Organization_ID: "1906", Message: "Details: integration test", Note: "resolved later" },
      ]),
    );
    expect(runImport(file)).toMatch(/0 inserted, 1 updated/);
    const [t] = await db<{ note: string; resolved_at: Date }[]>`select note, resolved_at from public.tickets where ticket_id = ${NEW_ID}`;
    expect(t.note).toBe("resolved later");

    await expect(
      db`update public.tickets set project_id = (select id from public.projects where code = 'DEMI_3RD'), organization_id = 1609 where ticket_id = ${NEW_ID}`,
    ).rejects.toThrow(/TICKET_ID_COLLISION/);
  });
});
