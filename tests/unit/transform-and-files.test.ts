import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTicketCsv } from "@/lib/ingest/csv";
import { SOURCE_COLUMNS, type SourceRow } from "@/lib/ingest/columns";
import { computeRowHash, transformRecord } from "@/lib/ingest/transform";
import { ProjectMappingError, processFile, resolveProject } from "@/lib/ingest/file";
import { BRIEF_EXPECTED_COUNTS, DEFAULT_PROJECTS } from "@/lib/ingest/default-projects";

const fixture = readFileSync(path.join(__dirname, "../fixtures/sample.csv"));

function row(overrides: Partial<SourceRow> = {}): SourceRow {
  const base = Object.fromEntries(SOURCE_COLUMNS.map((c) => [c, ""])) as SourceRow;
  return {
    ...base,
    Ticket_ID: "5",
    Topic: "Report a Problem / inquiry",
    Status: "completed",
    Created_At: "2026-09-01 10:00:00 +0300",
    Organization_ID: "1610",
    ...overrides,
  };
}

describe("transformRecord", () => {
  it("maps blanks to NULL and keeps free text verbatim", () => {
    const r = transformRecord({ rowNumber: 1, line: 2, values: row({ Message: "  Details: hi  ", Owner_ID: "  X-1 " }) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.record.message).toBe("  Details: hi  ");
    expect(r.row.record.owner_id).toBe("X-1");
    expect(r.row.record.priority).toBeNull();
    expect(r.row.record.responded_at).toBeNull();
    expect(r.row.record.status).toBe("completed");
  });

  it("keeps a missing status as NULL (never coerced to pending)", () => {
    const r = transformRecord({ rowNumber: 1, line: 2, values: row({ Status: "" }) });
    expect(r.ok && r.row.record.status).toBeNull();
  });

  it("rejects rows with missing or invalid required fields, with a reason", () => {
    const cases: Partial<SourceRow>[] = [{ Ticket_ID: "" }, { Ticket_ID: "12a" }, { Created_At: "" }, { Created_At: "yesterday" }, { Topic: "" }, { Organization_ID: "x" }, { Responded_At: "2026-99-01 00:00:00 +0300" }];
    for (const c of cases) {
      const r = transformRecord({ rowNumber: 7, line: 9, values: row(c) });
      expect(r.ok, JSON.stringify(c)).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("VALIDATION_FAILED");
        expect(r.error.rowNumber).toBe(7);
        expect(r.error.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("computes a stable row hash that changes with any source value", () => {
    const a = computeRowHash(row());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRowHash(row())).toBe(a);
    expect(computeRowHash(row({ Note: "changed" }))).not.toBe(a);
  });
});

describe("resolveProject", () => {
  const counts = (entries: [number, number][]) => new Map(entries);

  it("maps by filename and dominant Organization_ID", () => {
    expect(resolveProject("DEMI 3rd Intake Edu Tickets.csv", counts([[1609, 100]]), DEFAULT_PROJECTS).code).toBe("DEMI_3RD");
    expect(resolveProject("export-2026-11.csv", counts([[1939, 10]]), DEFAULT_PROJECTS).code).toBe("DEMI_SUMMER");
  });

  it("refuses a file whose name and organization disagree", () => {
    expect(() => resolveProject("DECI 4th Intake Edu Tickets.csv", counts([[1609, 100]]), DEFAULT_PROJECTS)).toThrow(ProjectMappingError);
  });

  it("refuses ambiguous files", () => {
    expect(() => resolveProject("export.csv", counts([[1609, 5], [1610, 5]]), DEFAULT_PROJECTS)).toThrow(ProjectMappingError);
    expect(() => resolveProject("export.csv", counts([[9999, 5]]), DEFAULT_PROJECTS)).toThrow(ProjectMappingError);
    expect(() => resolveProject("export.csv", counts([]), DEFAULT_PROJECTS)).toThrow(ProjectMappingError);
  });
});

describe("processFile", () => {
  it("computes file-level reconciliation statistics", () => {
    const pf = processFile("DECI 4th Intake Edu Tickets.csv", fixture, DEFAULT_PROJECTS);
    expect(pf.project.code).toBe("DECI_4TH");
    expect(pf.stats.records_in_file).toBe(3);
    expect(pf.stats.status_counts).toEqual({ completed: 1, pending: 1, __none__: 1 });
    expect(pf.stats.anomalies.resolved_before_responded).toBe(1);
    expect(pf.stats.missing.Priority).toBe(3);
    expect(pf.stats.offsets).toMatchObject({ "+0300": 6, "+0200": 1 });
    expect(pf.stats.offset_mismatches_vs_cairo).toBe(0);
    expect(pf.stats.attachments.request).toBe(1);
    expect(pf.rows[1].record.session_ref).toBe("5859718");
  });

  it("logs duplicate ticket IDs within a file instead of silently dropping them", () => {
    const text = parseTicketCsv(fixture);
    const header = SOURCE_COLUMNS.join(",");
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const line = (values: SourceRow) => SOURCE_COLUMNS.map((c) => esc(values[c])).join(",");
    const dup = { ...text.records[2].values, Ticket_ID: "1002", Resolved_At: "2026-09-05 10:00:00 +0300" };
    const csv = [header, ...text.records.map((r) => line(r.values)), line(dup)].join("\n");
    const pf = processFile("DECI 4th Intake Edu Tickets.csv", Buffer.from(csv), DEFAULT_PROJECTS);
    expect(pf.stats.records_in_file).toBe(4);
    expect(pf.rows).toHaveLength(3);
    expect(pf.errors).toHaveLength(1);
    expect(pf.errors[0]).toMatchObject({ code: "DUPLICATE_TICKET_IN_FILE", ticketId: 1002 });
    expect(pf.stats.accepted + pf.stats.rejected).toBe(pf.stats.records_in_file);
  });

  it("rejects rows from another organization individually", () => {
    const text = parseTicketCsv(fixture);
    const header = SOURCE_COLUMNS.join(",");
    const line = (values: SourceRow) => SOURCE_COLUMNS.map((c) => `"${values[c].replace(/"/g, '""')}"`).join(",");
    const stray = { ...text.records[0].values, Ticket_ID: "9999", Organization_ID: "1906" };
    const csv = [header, ...text.records.map((r) => line(r.values)), line(stray)].join("\n");
    const pf = processFile("DECI 4th Intake Edu Tickets.csv", Buffer.from(csv), DEFAULT_PROJECTS);
    expect(pf.errors.map((e) => e.code)).toEqual(["ORGANIZATION_MISMATCH"]);
  });
});

// Full-file validation against the real exports (skipped when data/raw is absent, e.g. in CI).
const RAW = path.resolve(__dirname, "../../data/raw");
const hasRaw = existsSync(RAW) && readdirSync(RAW).some((f) => f.endsWith(".csv"));

describe.skipIf(!hasRaw)("real exports in data/raw", () => {
  const files = hasRaw ? readdirSync(RAW).filter((f) => f.endsWith(".csv")) : [];
  const processed = files.map((f) => processFile(f, readFileSync(path.join(RAW, f)), DEFAULT_PROJECTS));

  it("maps every file to its project with the expected row counts", () => {
    const byProject = Object.fromEntries(processed.map((p) => [p.project.code, p.stats.records_in_file]));
    expect(byProject).toEqual(BRIEF_EXPECTED_COUNTS);
    expect(processed.every((p) => p.errors.length === 0)).toBe(true);
  });

  it("reproduces the known data-quality findings", () => {
    const sum = (fn: (p: (typeof processed)[number]) => number) => processed.reduce((a, p) => a + fn(p), 0);
    const ids = new Set(processed.flatMap((p) => p.rows.map((r) => r.record.ticket_id)));
    expect(sum((p) => p.stats.accepted)).toBe(12969);
    expect(ids.size).toBe(12969);
    expect(sum((p) => p.stats.status_counts.completed ?? 0)).toBe(12908);
    expect(sum((p) => p.stats.status_counts.pending ?? 0)).toBe(58);
    expect(sum((p) => p.stats.status_counts.rejected ?? 0)).toBe(2);
    expect(sum((p) => p.stats.status_counts.__none__ ?? 0)).toBe(1);
    expect(sum((p) => p.stats.missing.Responded_At)).toBe(1250);
    expect(sum((p) => p.stats.missing.Resolved_At)).toBe(62);
    expect(sum((p) => p.stats.anomalies.resolved_before_responded)).toBe(228);
    expect(sum((p) => p.stats.missing.Priority)).toBe(12969);
    expect(sum((p) => p.stats.missing.Affected_Student_ID)).toBe(12969);
    expect(sum((p) => p.stats.offset_mismatches_vs_cairo)).toBe(0);
  });
});
