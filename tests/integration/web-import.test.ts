import { readFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SOURCE_COLUMNS, type SourceRow } from "@/lib/ingest/columns";
import { buildXlsxTemplate } from "@/lib/imports/template";
import { runImportWorker } from "@/lib/imports/worker";
import type { ImportJobDetail, ImportPreview } from "@/lib/imports/types";
import { PUBLISHABLE_KEY, adminApi, anonClient, rpc, sql, stackReachable, userClient } from "./helpers";

const reachable = await stackReachable();
const RAW = path.resolve(__dirname, "../../data/raw");

/**
 * End-to-end web import: signed upload to private Storage, worker validation,
 * preview, confirmation, batched apply (web worker and pg_cron), archive & start
 * new (project and cycle), restore, concurrency guards and permissions.
 * Uses throwaway IT_* cycles/projects (organization IDs 9900xx) and cleans up.
 */

function csv(rows: Partial<SourceRow>[]): Buffer {
  const base = Object.fromEntries(SOURCE_COLUMNS.map((c) => [c, ""])) as SourceRow;
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return Buffer.from(`﻿${[SOURCE_COLUMNS.join(","), ...rows.map((r) => SOURCE_COLUMNS.map((c) => esc({ ...base, ...r }[c])).join(","))].join("\r\n")}\r\n`);
}

const ARABIC = "Details: كنت حاضر الجلسة\nلكن تم تسجيل غياب «اختبار»";
const T = (id: number, over: Partial<SourceRow> = {}): Partial<SourceRow> => ({
  Ticket_ID: String(id),
  Topic: "Virtual Session Absence Appeal",
  Message: "Details: integration",
  Status: "completed",
  Department: "education",
  Owner_Type: "Student",
  Owner_ID: `3021231010${id % 10000}`,
  Created_At: "2026-08-01 10:00:00 +0300",
  Responded_At: "2026-08-01 10:00:05 +0300",
  Resolved_At: "2026-08-02 10:00:00 +0300",
  Organization_ID: "990001",
  ...over,
});

describe.skipIf(!reachable)("web imports (storage → worker → preview → confirm → apply)", () => {
  let admin: SupabaseClient;
  let analyst: SupabaseClient;
  const svc = adminApi();
  const jobIds: string[] = [];

  async function upload(spec: Record<string, unknown>, file: Buffer, filename: string, contentType = "text/csv"): Promise<string> {
    const created = await rpc<{ id: string; storage_path: string }>(admin, "create_import_job", {
      p_spec: { ...spec, filename, size_bytes: file.length },
    });
    expect(created.error).toBeNull();
    jobIds.push(created.data.id);
    const { data: signed, error } = await svc.storage.from("imports").createSignedUploadUrl(created.data.storage_path);
    expect(error).toBeNull();
    // Exactly what the browser does: a raw PUT to the signed URL with the public key only.
    const put = await fetch(signed!.signedUrl, {
      method: "PUT",
      headers: { "content-type": contentType, "x-upsert": "false", apikey: PUBLISHABLE_KEY },
      body: new Uint8Array(file),
    });
    expect(put.status).toBe(200);
    const marked = await rpc(admin, "mark_import_uploaded", { p_job_id: created.data.id });
    expect(marked.error).toBeNull();
    return created.data.id;
  }

  async function job(id: string): Promise<ImportJobDetail> {
    const r = await rpc<ImportJobDetail>(admin, "get_import_job", { p_job_id: id });
    expect(r.error).toBeNull();
    return r.data;
  }

  async function validate(spec: Record<string, unknown>, file: Buffer, filename: string, contentType?: string) {
    const id = await upload(spec, file, filename, contentType);
    const w = await runImportWorker({ jobId: id, budgetMs: 120_000 });
    expect(w.errors).toEqual([]);
    return job(id);
  }

  async function confirmAndRun(d: ImportJobDetail, policy: "all_or_nothing" | "import_valid_rows") {
    const c = await rpc<{ status: string }>(admin, "confirm_import_job", { p_job_id: d.job.id, p_policy: policy, p_preview_version: d.job.preview_version });
    expect(c.error).toBeNull();
    expect(c.data.status).toBe("importing");
    const w = await runImportWorker({ jobId: d.job.id, budgetMs: 120_000 });
    expect(w.errors).toEqual([]);
    return job(d.job.id);
  }

  async function issues(id: string) {
    const r = await rpc<{ issues: { severity: string; code: string; row_number: number | null; column_name: string | null }[] }>(admin, "get_import_job_issues", { p_job_id: id, p_limit: 5000 });
    return r.data.issues;
  }

  beforeAll(async () => {
    admin = (await userClient("it-admin@local.test", "admin")).client;
    analyst = (await userClient("it-analyst@local.test", "analyst")).client;
    expect((await rpc(admin, "create_reporting_cycle", { p_cycle: { code: "IT_CYC_A", name: "IT cycle A" }, p_make_current: false })).error).toBeNull();
    const p = await rpc(admin, "create_project", {
      p_project: { code: "IT_P1", name: "IT project 1", program: "ITP", intake: "1st Intake", organization_id: 990001 },
      p_cycle: "IT_CYC_A",
    });
    expect(p.error).toBeNull();
  });

  afterAll(async () => {
    const db = sql();
    try {
      await db`update public.reporting_cycles set is_current = false where is_current and code <> 'CYCLE_2026'`;
      await db`update public.reporting_cycles set is_current = true where code = 'CYCLE_2026'`;
      const paths = await db<{ storage_path: string }[]>`select storage_path from public.import_jobs where original_filename like 'it-%'`;
      if (paths.length) await svc.storage.from("imports").remove(paths.map((p) => p.storage_path));
      const runs = await db<{ import_run_id: string }[]>`select import_run_id from public.import_jobs where original_filename like 'it-%' and import_run_id is not null`;
      await db`delete from public.import_jobs where original_filename like 'it-%'`;
      await db`delete from public.tickets where project_id in (select id from public.projects where code like 'IT\\_%')`;
      if (runs.length) await db`delete from public.import_runs where id in ${db(runs.map((r) => r.import_run_id))}`;
      await db`delete from public.import_runs where project_id in (select id from public.projects where code like 'IT\\_%') or source_filename like 'it-%'`;
      await db`delete from public.projects where code like 'IT\\_%'`;
      await db`delete from public.reporting_cycles where code like 'IT\\_%'`;
      await db`delete from public.topic_categories where topic = 'IT brand-new topic'`;
      await db`delete from public.ticket_statuses where status = 'escalated'`;
    } finally {
      await db.end();
    }
  });

  it("rejects a malformed file with a clear, file-level reason", async () => {
    const bad = Buffer.from("Ticket,Subject\n1,hello\n");
    const d = await validate({ mode: "upsert", project_code: "IT_P1" }, bad, "it-malformed.csv");
    expect(d.job.status).toBe("failed");
    expect(d.job.error_code).toBe("HEADER_MISMATCH");
    expect(d.job.last_error).toMatch(/Missing/);
    expect(d.issue_counts.some((i) => i.code === "HEADER_MISMATCH" && i.severity === "error")).toBe(true);
  });

  it("refuses a file exported for another project's organization", async () => {
    const d = await validate({ mode: "upsert", project_code: "IT_P1" }, csv([T(999200001, { Organization_ID: "1906" }), T(999200002, { Organization_ID: "1906" })]), "it-wrong-org.csv");
    expect(d.job.status).toBe("failed");
    expect(d.job.error_code).toBe("ORGANIZATION_NOT_FOUND");
  });

  it("validates, previews and imports valid rows; invalid rows are recorded, never dropped", async () => {
    const file = csv([
      T(999200101, { Message: ARABIC, Attachment_URLs: "https://api.ischooltech.com/files/a.pdf" }),
      T(999200102, { Status: "pending", Resolved_At: "" }),
      T(999200103, { Organization_ID: "" }),
      T(999200104, { Status: "escalated", Topic: "IT brand-new topic" }),
      T(999200105, { Created_At: "31/08/2026 10:00" }),
      T(999200101, { Created_At: "2026-07-01 10:00:00 +0300", Responded_At: "", Resolved_At: "" }),
      T(999200106, { Note: "TEMPLATE EXAMPLE - DO NOT IMPORT" }),
      T(999200107, { Created_At: "2026-08-03T09:00:00+03:00", Responded_At: "", Resolved_At: "" }),
    ]);
    const d = await validate({ mode: "upsert", project_code: "IT_P1" }, file, "it-mixed.csv");
    expect(d.job.status).toBe("ready");
    const p = d.job.preview as ImportPreview;
    expect(p.counts).toMatchObject({ total: 8, valid: 5, invalid: 3, new: 5, updated: 0, unchanged: 0, duplicates: 1 });
    const codes = new Set((await issues(d.job.id)).map((i) => i.code));
    for (const c of ["INVALID_TIMESTAMP", "DUPLICATE_TICKET_IN_FILE", "SAMPLE_ROW", "STATUS_NOT_CONFIGURED", "TOPIC_UNMAPPED", "TIMESTAMP_CONVERTED"]) expect(codes).toContain(c);
    expect(d.job.validation_summary.organization_filled).toBe(1);

    // All-or-nothing refuses a file with invalid rows; a stale preview version is refused too.
    const strict = await rpc(admin, "confirm_import_job", { p_job_id: d.job.id, p_policy: "all_or_nothing", p_preview_version: d.job.preview_version });
    expect(strict.error?.message).toMatch(/3 row\(s\) are invalid/);
    const stale = await rpc<{ preview_changed?: boolean }>(admin, "confirm_import_job", { p_job_id: d.job.id, p_policy: "import_valid_rows", p_preview_version: d.job.preview_version - 1 });
    expect(stale.data.preview_changed).toBe(true);

    const done = await confirmAndRun(await job(d.job.id), "import_valid_rows");
    expect(done.job.status).toBe("completed_with_errors");
    expect(done.run).toMatchObject({ status: "completed_with_errors", inserted_count: 5, rejected_count: 3, records_in_file: 8 });

    const db = sql();
    try {
      const [t] = await db<{ message: string; organization_id: number; atts: number; cat: string }[]>`
        select t.message, t.organization_id,
          (select count(*)::int from public.ticket_attachments a where a.ticket_pk = t.id) as atts,
          (select k.code from public.ticket_classifications c join public.ticket_categories k on k.id = c.category_id where c.ticket_pk = t.id and c.is_current) as cat
        from public.tickets t join public.projects p on p.id = t.project_id where p.code = 'IT_P1' and t.ticket_id = 999200101`;
      expect(t.message).toBe(ARABIC);
      expect(t.atts).toBe(1);
      expect(t.cat).toBe("attendance_appeals");
      const [{ org }] = await db<{ org: number }[]>`select organization_id as org from public.tickets where ticket_id = 999200103`;
      expect(org).toBe(990001);
      const errs = await db<{ error_code: string }[]>`select error_code from public.import_errors where import_run_id = ${done.run!.id} order by error_code`;
      expect(errs.map((e) => e.error_code)).toEqual(["DUPLICATE_TICKET_IN_FILE", "SAMPLE_ROW", "VALIDATION_FAILED"]);
      const staged = await db<{ n: number }[]>`select count(*)::int as n from public.import_job_rows where job_id = ${d.job.id}`;
      expect(staged[0].n).toBe(0);
    } finally {
      await db.end();
    }
  });

  it("is idempotent: re-importing the same file inserts and updates nothing", async () => {
    const file = csv([
      T(999200101, { Message: ARABIC, Attachment_URLs: "https://api.ischooltech.com/files/a.pdf" }),
      T(999200102, { Status: "pending", Resolved_At: "" }),
      T(999200103, { Organization_ID: "" }),
      T(999200104, { Status: "escalated", Topic: "IT brand-new topic" }),
      T(999200105, { Created_At: "31/08/2026 10:00" }),
      T(999200101, { Created_At: "2026-07-01 10:00:00 +0300", Responded_At: "", Resolved_At: "" }),
      T(999200106, { Note: "TEMPLATE EXAMPLE - DO NOT IMPORT" }),
      T(999200107, { Created_At: "2026-08-03T09:00:00+03:00", Responded_At: "", Resolved_At: "" }),
    ]);
    const d = await validate({ mode: "upsert", project_code: "IT_P1" }, file, "it-mixed-again.csv");
    expect((d.job.preview as ImportPreview).counts).toMatchObject({ new: 0, updated: 0, unchanged: 5, invalid: 3 });
    const done = await confirmAndRun(d, "import_valid_rows");
    expect(done.run).toMatchObject({ inserted_count: 0, updated_count: 0, skipped_unchanged_count: 5 });
  });

  it("applies newer exports with field history and never lets older exports overwrite newer data", async () => {
    const newer = csv([
      T(999200102, { Status: "completed", Resolved_At: "2026-08-20 12:00:00 +0300", Note: "closed after follow-up" }),
      T(999200108, { Created_At: "2026-08-19 08:00:00 +0300", Responded_At: "", Resolved_At: "" }),
    ]);
    const d = await validate({ mode: "upsert", project_code: "IT_P1" }, newer, "it-newer.csv");
    const p = d.job.preview as ImportPreview;
    expect(p.counts).toMatchObject({ new: 1, updated: 1, unchanged: 0 });
    expect(p.field_changes).toMatchObject({ Status: 1, Resolved_At: 1, Note: 1 });
    expect(p.absent_existing).toBe(4); // tickets not in this export are kept, not deleted
    const done = await confirmAndRun(d, "all_or_nothing");
    expect(done.run).toMatchObject({ status: "completed", inserted_count: 1, updated_count: 1 });

    const db = sql();
    try {
      const [h] = await db<{ changes: Record<string, { old: unknown; new: unknown }> }[]>`
        select c.changes from public.ticket_changes c join public.tickets t on t.id = c.ticket_pk where t.ticket_id = 999200102 order by c.changed_at desc limit 1`;
      expect(h.changes.Status).toEqual({ old: "pending", new: "completed" });
      expect(Object.keys(h.changes)).toEqual(expect.arrayContaining(["Status", "Resolved_At", "Note"]));
      const [{ n }] = await db<{ n: number }[]>`select count(*)::int as n from public.tickets t join public.projects p on p.id = t.project_id where p.code = 'IT_P1'`;
      expect(n).toBe(6);
    } finally {
      await db.end();
    }

    // An older export (latest timestamp before the stored one) is "stale".
    const older = csv([T(999200102, { Status: "pending", Resolved_At: "", Responded_At: "", Created_At: "2026-08-01 10:00:00 +0300" })]);
    const o = await validate({ mode: "upsert", project_code: "IT_P1" }, older, "it-older.csv");
    expect((o.job.preview as ImportPreview).counts).toMatchObject({ stale: 1, updated: 0 });
    expect((await issues(o.job.id)).some((i) => i.code === "STALE_EXPORT_ROW")).toBe(true);
    const od = await confirmAndRun(o, "all_or_nothing");
    expect(od.run).toMatchObject({ skipped_stale_count: 1, updated_count: 0 });
    const db2 = sql();
    try {
      const [{ status }] = await db2<{ status: string }[]>`select status from public.tickets where ticket_id = 999200102`;
      expect(status).toBe("completed");
    } finally {
      await db2.end();
    }
  });

  it("imports an Excel workbook made from the template (text IDs, Excel dates, examples ignored)", async () => {
    const tpl = await buildXlsxTemplate({
      project: { code: "IT_P1", name: "IT project 1", program: "ITP", intake: "1st Intake", organization_id: 990001 },
      statuses: [{ status: "completed", label: "Completed", class: "closed" }],
      topics: [],
      generatedAt: new Date(),
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Tickets")!;
    const row = (vals: Partial<Record<(typeof SOURCE_COLUMNS)[number], ExcelJS.CellValue>>): ExcelJS.CellValue[] => SOURCE_COLUMNS.map((c) => vals[c] ?? null);
    // Typed into the first rows like a user would; the second row has Excel-native numbers and a date cell.
    sheet.getRow(2).values = row({ Ticket_ID: "999200201", Topic: "Report a Problem / inquiry", Status: "completed", Created_At: "2026-08-05 09:00:00 +0300", Message: "Details: مرحبا", Organization_ID: "990001" });
    sheet.getRow(3).values = row({ Ticket_ID: 999200202, Topic: "Report a Problem / inquiry", Status: "completed", Created_At: new Date(Date.UTC(2026, 7, 6, 14, 30, 0)), Owner_ID: 30212310100734 });
    sheet.getCell(3, SOURCE_COLUMNS.indexOf("Created_At") + 1).numFmt = "yyyy-mm-dd hh:mm:ss";
    const file = Buffer.from(await wb.xlsx.writeBuffer());
    const d = await validate({ mode: "upsert", project_code: "IT_P1" }, file, "it-workbook.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(d.job.status).toBe("ready");
    expect((d.job.preview as ImportPreview).counts).toMatchObject({ total: 2, valid: 2, new: 2 });
    expect((await issues(d.job.id)).some((i) => i.code === "TIMESTAMP_ASSUMED_CAIRO" && i.column_name === "Created_At")).toBe(true);
    await confirmAndRun(d, "all_or_nothing");
    const db = sql();
    try {
      const [t] = await db<{ created_at: Date; owner_id: string }[]>`select created_at, owner_id from public.tickets where ticket_id = 999200202`;
      expect(t.created_at.toISOString()).toBe("2026-08-06T11:30:00.000Z"); // 14:30 Cairo summer time (+03:00)
      expect(t.owner_id).toBe("30212310100734");
    } finally {
      await db.end();
    }
  });

  it("re-imports a real export through the web without changing anything", async () => {
    const file = readFileSync(path.join(RAW, "DECI Summer Intake Edu Tickets.csv"));
    const before = await rpc<{ rows: { tickets: number }[] }>(admin, "get_grouped_metrics", { p_filters: {}, p_dimension: "none" });
    const d = await validate({ mode: "upsert", project_code: "DECI_SUMMER" }, file, "it-deci-summer.csv");
    expect((d.job.preview as ImportPreview).counts).toMatchObject({ total: 582, valid: 582, new: 0, updated: 0, unchanged: 582, invalid: 0 });
    const done = await confirmAndRun(d, "all_or_nothing");
    expect(done.run).toMatchObject({ status: "completed", skipped_unchanged_count: 582, inserted_count: 0, updated_count: 0 });
    const after = await rpc<{ rows: { tickets: number }[] }>(admin, "get_grouped_metrics", { p_filters: {}, p_dimension: "none" });
    expect(after.data.rows[0].tickets).toBe(before.data.rows[0].tickets);
    expect(after.data.rows[0].tickets).toBe(12969);
  });

  it("pg_cron applies a confirmed import on its own (no web worker after confirmation)", async () => {
    const d = await validate({ mode: "upsert", project_code: "IT_P1" }, csv([T(999200301), T(999200302)]), "it-cron.csv");
    const c = await rpc(admin, "confirm_import_job", { p_job_id: d.job.id, p_policy: "all_or_nothing", p_preview_version: d.job.preview_version });
    expect(c.error).toBeNull();
    let status = "importing";
    for (let i = 0; i < 25 && status === "importing"; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      status = (await job(d.job.id)).job.status;
    }
    expect(status).toBe("completed");
  }, 90_000);

  it("guards concurrent changes: no archive or second import while an import is running", async () => {
    const d = await validate({ mode: "upsert", project_code: "IT_P1" }, csv([T(999200401)]), "it-lock-a.csv");
    const e = await validate({ mode: "upsert", project_code: "IT_P1" }, csv([T(999200402)]), "it-lock-b.csv");
    const db = sql();
    try {
      // Simulate a running import held by a live worker lease.
      await db`update public.import_jobs set status = 'importing', lease_owner = 'test-holder', lease_expires_at = now() + interval '10 minutes' where id = ${d.job.id}`;
      const arch = await rpc(admin, "archive_project", { p_code: "IT_P1", p_reason: "test", p_confirm: "IT_P1" });
      expect(arch.error?.message).toMatch(/import is currently running/);
      const second = await rpc(admin, "confirm_import_job", { p_job_id: e.job.id, p_policy: "all_or_nothing", p_preview_version: e.job.preview_version });
      expect(second.error?.message).toMatch(/import is currently running/);
      await db`update public.import_jobs set status = 'ready', lease_owner = null, lease_expires_at = null where id = ${d.job.id}`;
    } finally {
      await db.end();
    }
    expect((await rpc(admin, "cancel_import_job", { p_job_id: d.job.id })).error).toBeNull();
    expect((await rpc(admin, "cancel_import_job", { p_job_id: e.job.id })).error).toBeNull();
  });

  it("archive & start new (project): the old project is archived, the new one replaces it atomically", async () => {
    const file = csv([T(999200101), T(999200501)]);
    const d = await validate(
      {
        mode: "archive_and_start",
        archive_scope: "project",
        archive_project_code: "IT_P1",
        new_project: { code: "IT_P2", name: "IT project 2", program: "ITP", intake: "2nd Intake", organization_id: 990001 },
      },
      file,
      "it-fresh-project.csv",
    );
    expect(d.job.status).toBe("ready");
    expect((d.job.preview as ImportPreview).counts).toMatchObject({ new: 2, unchanged: 0 });
    expect((d.job.preview as ImportPreview).ids_in_archived_target).toBe(1);

    // Before completion the draft project is invisible and IT_P1 still active.
    const c = await rpc(admin, "confirm_import_job", { p_job_id: d.job.id, p_policy: "all_or_nothing", p_preview_version: d.job.preview_version });
    expect(c.error).toBeNull();
    const mid = await rpc<{ projects: { code: string }[] }>(analyst, "get_filter_options", { p_scope: { cycle: "IT_CYC_A" } });
    if ((await job(d.job.id)).job.status === "importing") expect(mid.data.projects.map((p) => p.code)).toEqual(["IT_P1"]);
    await runImportWorker({ jobId: d.job.id, budgetMs: 60_000 });
    expect((await job(d.job.id)).job.status).toBe("completed");

    const scope = await rpc<{ projects: { code: string }[]; total_tickets: number }>(analyst, "get_filter_options", { p_scope: { cycle: "IT_CYC_A" } });
    expect(scope.data.projects.map((p) => p.code)).toEqual(["IT_P2"]);
    expect(scope.data.total_tickets).toBe(2);
    const hist = await rpc<{ projects: { code: string; status: string }[] }>(analyst, "get_filter_options", { p_scope: { cycle: "IT_CYC_A", include_archived: true } });
    expect(hist.data.projects.map((p) => `${p.code}:${p.status}`).sort()).toEqual(["IT_P1:archived", "IT_P2:active"]);

    // The same source ID now exists in the archived and the new project.
    const amb = await rpc<{ ambiguous?: boolean; candidates?: unknown[] }>(admin, "get_ticket_detail", { p_ticket_id: 999200101 });
    expect(amb.data.ambiguous).toBe(true);
    const one = await rpc<{ project_code: string }>(admin, "get_ticket_detail", { p_ticket_id: 999200101, p_project_code: "IT_P1" });
    expect(one.data.project_code).toBe("IT_P1");

    // Archived projects are read-only for imports.
    const ro = await rpc(admin, "create_import_job", { p_spec: { mode: "upsert", project_code: "IT_P1", filename: "it-x.csv", size_bytes: 10 } });
    expect(ro.error?.message).toMatch(/archived and read-only/);
    // Restore needs the Organization_ID to be free.
    expect((await rpc(admin, "restore_project", { p_code: "IT_P1" })).error?.message).toMatch(/already used by active project IT_P2/);
    expect((await rpc(admin, "archive_project", { p_code: "IT_P2", p_reason: "test", p_confirm: "wrong" })).error?.message).toMatch(/Confirmation does not match/);
    expect((await rpc(admin, "archive_project", { p_code: "IT_P2", p_reason: "test", p_confirm: "IT_P2" })).error).toBeNull();
    expect((await rpc(admin, "restore_project", { p_code: "IT_P1" })).error).toBeNull();
    const db = sql();
    try {
      const [{ n }] = await db<{ n: number }[]>`select count(*)::int as n from public.tickets t join public.projects p on p.id = t.project_id where p.code = 'IT_P1'`;
      expect(n).toBe(10); // archiving never deleted anything
    } finally {
      await db.end();
    }
  });

  it("archive & start new (cycle): a fresh cycle becomes current; history stays separate and restorable", async () => {
    const d = await validate(
      {
        mode: "archive_and_start",
        archive_scope: "cycle",
        archive_cycle_code: "IT_CYC_A",
        new_cycle: { code: "IT_CYC_B", name: "IT cycle B" },
        new_project: { code: "IT_P3", name: "IT project 3", program: "ITP", intake: "3rd Intake", organization_id: 990002 },
      },
      csv([T(999200601, { Organization_ID: "990002" }), T(999200602, { Organization_ID: "990002" }), T(999200603, { Organization_ID: "990002" })]),
      "it-fresh-cycle.csv",
    );
    const done = await confirmAndRun(d, "all_or_nothing");
    expect(done.job.status).toBe("completed");

    const def = await rpc<{ scope: { cycle: string }; total_tickets: number }>(analyst, "get_filter_options", { p_scope: {} });
    expect(def.data.scope.cycle).toBe("IT_CYC_B");
    expect(def.data.total_tickets).toBe(3);
    const old = await rpc<{ scope: { cycle_status: string; include_archived: boolean }; total_tickets: number }>(analyst, "get_filter_options", { p_scope: { cycle: "IT_CYC_A" } });
    expect(old.data.scope).toMatchObject({ cycle_status: "archived", include_archived: true });
    expect(old.data.total_tickets).toBe(12); // IT_P1 (10) + IT_P2 (2), both archived
    const original = await rpc<{ rows: { tickets: number }[] }>(analyst, "get_grouped_metrics", { p_filters: { cycle: "CYCLE_2026" }, p_dimension: "none" });
    expect(original.data.rows[0].tickets).toBe(12969);

    expect((await rpc(admin, "set_current_cycle", { p_code: "CYCLE_2026" })).error).toBeNull();
    const back = await rpc<{ rows: { tickets: number }[] }>(analyst, "get_grouped_metrics", { p_filters: {}, p_dimension: "none" });
    expect(back.data.rows[0].tickets).toBe(12969);
    const restored = await rpc<{ restored_projects: number }>(admin, "restore_cycle", { p_code: "IT_CYC_A" });
    expect(restored.error).toBeNull();
    expect(restored.data.restored_projects).toBe(1); // IT_P1 (archived with the cycle); IT_P2 stays archived
  });

  it("maps new topics and classifies new statuses, updating analytics immediately", async () => {
    const before = await rpc<{ unmapped_topics: number }>(admin, "get_filter_options", { p_scope: { cycle: "IT_CYC_A" } });
    expect(before.data.unmapped_topics).toBeGreaterThan(0);
    const m = await rpc<{ tickets_reclassified: number }>(admin, "set_topic_category", { p_topic: "IT brand-new topic", p_category_code: "general_inquiry" });
    expect(m.error).toBeNull();
    expect(m.data.tickets_reclassified).toBeGreaterThan(0);
    const after = await rpc<{ unmapped_topics: number }>(admin, "get_filter_options", { p_scope: { cycle: "IT_CYC_A" } });
    expect(after.data.unmapped_topics).toBe(before.data.unmapped_topics - 1);

    const open = await rpc<{ rows: { unclassified_status: number; open_tickets: number }[] }>(admin, "get_grouped_metrics", { p_filters: { cycle: "IT_CYC_A", statuses: ["escalated"] }, p_dimension: "none" });
    expect(open.data.rows[0].unclassified_status).toBeGreaterThan(0);
    expect((await rpc(admin, "set_status_class", { p_status: "escalated", p_class: "closed" })).error).toBeNull();
    const closed = await rpc<{ rows: { unclassified_status: number; open_tickets: number }[] }>(admin, "get_grouped_metrics", { p_filters: { cycle: "IT_CYC_A", statuses: ["escalated"] }, p_dimension: "none" });
    expect(closed.data.rows[0].unclassified_status).toBe(0);
  });

  it("only administrators can import, manage projects or mappings; workers need the service role", async () => {
    const spec = { mode: "upsert", project_code: "IT_P1", filename: "it-x.csv", size_bytes: 10 };
    for (const [fn, args] of [
      ["create_import_job", { p_spec: spec }],
      ["create_project", { p_project: { code: "IT_X", name: "x", program: "ITP", intake: "x", organization_id: 990009 } }],
      ["archive_project", { p_code: "IT_P1", p_reason: "", p_confirm: "IT_P1" }],
      ["archive_cycle", { p_code: "IT_CYC_A", p_reason: "", p_confirm: "IT_CYC_A" }],
      ["set_topic_category", { p_topic: "x", p_category_code: "general_inquiry" }],
      ["set_status_class", { p_status: "x", p_class: "open" }],
      ["update_insight_rule", { p_key: "trend_min_current", p_value: 10 }],
      ["get_import_jobs", {}],
    ] as const) {
      const r = await rpc(analyst, fn, args);
      expect(r.error?.code, fn).toBe("42501");
    }
    // Worker functions are not even executable by signed-in users (including admins).
    expect((await rpc(admin, "worker_claim_job", { p_worker: "x" })).error?.code).toBe("42501");
    expect((await rpc(analyst, "worker_apply_batch", { p_job_id: jobIds[0], p_worker: "x" })).error?.code).toBe("42501");
    // Staging rows are unreachable through the API; job metadata is admin-only.
    expect((await analyst.from("import_job_rows").select("record").limit(1)).error?.code).toBe("42501");
    expect((await admin.from("import_job_rows").select("record").limit(1)).error?.code).toBe("42501");
    expect((await analyst.from("import_jobs").select("id").limit(5)).data).toEqual([]);
    expect((await analyst.from("ticket_changes").select("changes").limit(5)).data).toEqual([]);
    // Analysts keep read access to scoped analytics and history.
    expect((await rpc(analyst, "get_scope_catalog")).error).toBeNull();
    expect((await rpc(analyst, "get_topic_mappings")).error).toBeNull();
    const anon = await anonClient();
    expect((await rpc(anon, "get_scope_catalog")).error).not.toBeNull();
    expect((await anon.storage.from("imports").list()).data ?? []).toEqual([]);
    // Uploaded files are private: no public URL works and analysts cannot download them.
    const { data: files } = await svc.storage.from("imports").list(jobIds[0]);
    expect(files?.length).toBeGreaterThan(0);
    const dl = await analyst.storage.from("imports").download(`${jobIds[0]}/${files![0].name}`);
    expect(dl.data).toBeNull();
  });
});
