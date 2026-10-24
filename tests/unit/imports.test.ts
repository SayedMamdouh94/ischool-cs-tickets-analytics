import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { SOURCE_COLUMNS, type SourceRow } from "@/lib/ingest/columns";
import { CsvStructureError, HeaderMismatchError, decodeCsv, parseTicketCsv } from "@/lib/ingest/csv";
import { COLUMN_DOCS, TEMPLATE_EXAMPLE_MARKER } from "@/lib/imports/constants";
import { normalizeTimestampText } from "@/lib/imports/normalize";
import { readUpload } from "@/lib/imports/read-upload";
import { validationReportCsv } from "@/lib/imports/report";
import { buildCsvTemplate, buildXlsxTemplate } from "@/lib/imports/template";
import { validateUpload, type ValidationContext } from "@/lib/imports/validate";

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  project: { code: "DECI_4TH", organization_id: 1610 },
  configuredStatuses: new Set(["pending", "completed", "rejected", "__none__"]),
  mappedTopics: new Set(["Report a Problem / inquiry"]),
  now: new Date("2026-10-23T12:00:00Z"),
  ...over,
});

function csv(rows: Partial<SourceRow>[], header: readonly string[] = SOURCE_COLUMNS, sep = ","): Buffer {
  const base = Object.fromEntries(SOURCE_COLUMNS.map((c) => [c, ""])) as SourceRow;
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return Buffer.from([header.join(sep), ...rows.map((r) => SOURCE_COLUMNS.map((c) => esc({ ...base, ...r }[c])).join(sep))].join("\r\n"));
}

const ok = (id: number, over: Partial<SourceRow> = {}): Partial<SourceRow> => ({
  Ticket_ID: String(id),
  Topic: "Report a Problem / inquiry",
  Status: "completed",
  Created_At: "2026-09-01 10:00:00 +0300",
  Resolved_At: "2026-09-02 10:00:00 +0300",
  Organization_ID: "1610",
  ...over,
});

describe("timestamp normalization", () => {
  it("leaves the export format byte-for-byte unchanged (row hashes stay stable)", () => {
    expect(normalizeTimestampText("2026-09-01 00:08:39 +0300")).toEqual({ value: "2026-09-01 00:08:39 +0300" });
    expect(normalizeTimestampText("")).toEqual({ value: "" });
  });
  it("converts ISO-8601 with an offset or Z", () => {
    expect(normalizeTimestampText("2026-09-01T10:15:00+03:00")).toEqual({ value: "2026-09-01 10:15:00 +0300", note: "converted" });
    expect(normalizeTimestampText("2026-09-01T07:15:00.123Z")).toEqual({ value: "2026-09-01 07:15:00 +0000", note: "converted" });
  });
  it("reads times without an offset as Africa/Cairo, DST-aware", () => {
    expect(normalizeTimestampText("2026-08-01 10:00")).toEqual({ value: "2026-08-01 10:00:00 +0300", note: "assumed_cairo" });
    expect(normalizeTimestampText("2026-12-01 10:00:00")).toEqual({ value: "2026-12-01 10:00:00 +0200", note: "assumed_cairo" });
  });
  it("never guesses ambiguous day/month formats", () => {
    expect(normalizeTimestampText("01/09/2026 10:00")).toEqual({ value: "01/09/2026 10:00" });
  });
});

describe("CSV decoding and headers", () => {
  it("rejects encodings that would corrupt Arabic text", () => {
    const cp1256 = Buffer.from([0x54, 0x6f, 0x70, 0x69, 0x63, 0x0d, 0x0a, 0xc7, 0xe1, 0xd4]); // "Topic\r\nالش" in Windows-1256
    expect(() => decodeCsv(cp1256)).toThrow(/not valid UTF-8/);
    expect(() => decodeCsv(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toThrow(/UTF-16/);
    expect(() => decodeCsv(Buffer.from("PK\u0003\u0004rest"))).toThrow(/Excel workbook/);
    expect(() => decodeCsv(Buffer.alloc(0))).toThrow(/empty/);
  });
  it("detects semicolon and tab delimiters from the header", () => {
    expect(decodeCsv(Buffer.from(`${SOURCE_COLUMNS.join(";")}\n`)).delimiter).toBe(";");
    expect(decodeCsv(Buffer.from(`${SOURCE_COLUMNS.join("\t")}\n`)).delimiter).toBe("\t");
    expect(decodeCsv(Buffer.from(`﻿${SOURCE_COLUMNS.join(",")}\n`)).delimiter).toBe(",");
  });
  it("is strict for the CLI and helpful for web uploads", () => {
    const variant = SOURCE_COLUMNS.map((c) => c.toLowerCase().replace(/_/g, " "));
    expect(() => parseTicketCsv(csv([ok(1)], variant))).toThrow(HeaderMismatchError);
    const lenient = parseTicketCsv(csv([ok(1)], [...variant]), { lenientHeader: true });
    expect(lenient.records[0].values.Ticket_ID).toBe("1");
    const extra = parseTicketCsv(`${[...SOURCE_COLUMNS, "Project"].join(",")}\n${Array(20).fill("").join(",")}`, { lenientHeader: true });
    expect(extra.ignoredColumns).toEqual(["Project"]);
    try {
      parseTicketCsv(SOURCE_COLUMNS.filter((c) => c !== "Created_At").join(","), { lenientHeader: true });
      expect.unreachable();
    } catch (err) {
      expect((err as HeaderMismatchError).missing).toEqual(["Created_At"]);
    }
    // A data row with a different number of fields than the header is a structure error.
    expect(() => parseTicketCsv(`${SOURCE_COLUMNS.join(",")}\n1,2,3`, { lenientHeader: true })).toThrow(/CSV parse error/);
  });
});

describe("web import validation", () => {
  it("accepts a clean export and counts nothing as invalid", async () => {
    const out = validateUpload(await readUpload(csv([ok(1), ok(2)]), "csv"), ctx());
    expect(out.summary).toMatchObject({ rows_total: 2, rows_valid: 2, rows_invalid: 0 });
    expect(out.stageRows.every((r) => r.is_valid && r.record && r.row_hash)).toBe(true);
    expect(out.stageRows[0].theme?.version).toBe("rules-v1");
  });

  it("refuses a file that belongs to another organization", async () => {
    await expect(readUpload(csv([ok(1, { Organization_ID: "1906" }), ok(2, { Organization_ID: "1906" })]), "csv").then((c) => validateUpload(c, ctx()))).rejects.toThrow(
      /does not belong to DECI_4TH/,
    );
  });

  it("explains each blocking error with row, line and column; never drops a row silently", async () => {
    const file = csv([
      ok(1),
      ok(2, { Created_At: "" }),
      ok(3, { Created_At: "2026-02-30 10:00:00 +0200" }),
      ok(4, { Ticket_ID: "12a" }),
      ok(5, { Organization_ID: "1906" }),
      ok(1, { Created_At: "2026-08-01 10:00:00 +0300", Resolved_At: "" }),
      ok(6, { Note: TEMPLATE_EXAMPLE_MARKER }),
      ok(7, { Message: "Details: ��" }),
    ]);
    const out = validateUpload(await readUpload(file, "csv"), ctx());
    expect(out.summary.rows_total).toBe(8);
    expect(out.summary.rows_valid + out.summary.rows_invalid).toBe(8);
    expect(out.stageRows.filter((r) => !r.is_valid).map((r) => [r.row_number, r.error_code])).toEqual([
      [2, "VALIDATION_FAILED"],
      [3, "VALIDATION_FAILED"],
      [4, "VALIDATION_FAILED"],
      [5, "ORGANIZATION_MISMATCH"],
      [6, "DUPLICATE_TICKET_IN_FILE"],
      [7, "SAMPLE_ROW"],
      [8, "TEXT_ENCODING"],
    ]);
    const byRow = (n: number) => out.rowIssues.filter((i) => i.row_number === n);
    expect(byRow(2)).toEqual([expect.objectContaining({ severity: "error", code: "MISSING_REQUIRED", column_name: "Created_At", line: 3 })]);
    expect(byRow(3)[0]).toMatchObject({ code: "INVALID_TIMESTAMP", value_excerpt: "2026-02-30 10:00:00 +0200" });
    expect(byRow(4)[0]).toMatchObject({ code: "INVALID_TICKET_ID", column_name: "Ticket_ID" });
    // Invalid rows keep their raw values for the import report.
    expect(out.stageRows.find((r) => r.row_number === 4)?.raw?.Ticket_ID).toBe("12a");
  });

  it("fills an empty Organization_ID from the selected project", async () => {
    const out = validateUpload(await readUpload(csv([ok(1, { Organization_ID: "" }), ok(2)]), "csv"), ctx());
    expect(out.summary.organization_filled).toBe(1);
    expect(out.stageRows[0].organization_id).toBe(1610);
    expect(out.fileIssues.some((i) => i.code === "ORGANIZATION_FILLED")).toBe(true);
  });

  it("flags data-quality problems as warnings without rejecting rows", async () => {
    const file = csv([
      ok(1, { Status: "escalated", Topic: "Brand new topic" }),
      ok(2, { Resolved_At: "2026-08-30 10:00:00 +0300" }),
      ok(3, { Created_At: "2026-12-25 10:00:00 +0200", Resolved_At: "" }),
      ok(4, { Status: "completed", Resolved_At: "" }),
      ok(5, { Message: "Details: Ø§Ù„Ø­Ø¶ÙˆØ± garbled" }),
      ok(6, { Attachment_URLs: "not-a-url" }),
    ]);
    const out = validateUpload(await readUpload(file, "csv"), ctx());
    expect(out.summary.rows_invalid).toBe(0);
    const codes = Object.keys(out.summary.by_code);
    for (const c of ["STATUS_NOT_CONFIGURED", "TOPIC_UNMAPPED", "TIMESTAMP_ORDER", "FUTURE_TIMESTAMP", "STATUS_TIMESTAMP_MISMATCH", "MOJIBAKE_SUSPECTED", "ATTACHMENT_URL_INVALID"]) {
      expect(codes, c).toContain(c);
    }
    expect(out.summary.new_topics).toEqual([{ topic: "Brand new topic", rows: 1 }]);
    expect(out.summary.unconfigured_statuses).toEqual([{ status: "escalated", rows: 1 }]);
    // Free text never appears in issue excerpts.
    expect(out.rowIssues.every((i) => !i.value_excerpt?.includes("garbled"))).toBe(true);
  });

  it("rejects an empty file and a header-only file", async () => {
    await expect(readUpload(Buffer.alloc(0), "csv")).rejects.toThrow(CsvStructureError);
    await expect(readUpload(csv([]), "csv").then((c) => validateUpload(c, ctx()))).rejects.toThrow(/no ticket rows/);
  });

  it("reads semicolon-separated CSV saved by European Excel", async () => {
    const out = validateUpload(await readUpload(csv([ok(1), ok(2)], SOURCE_COLUMNS, ";"), "csv"), ctx());
    expect(out.summary.rows_valid).toBe(2);
    expect(out.summary.delimiter).toBe(";");
  });
});

describe("templates", () => {
  it("CSV template: UTF-8 BOM and the 19 columns in export order", () => {
    const t = buildCsvTemplate();
    expect(t.startsWith("﻿")).toBe(true);
    expect(t.slice(1).trim().split(",")).toEqual([...SOURCE_COLUMNS]);
  });

  it("Excel template: data sheet first, instructions and examples separate, IDs as text", async () => {
    const buf = await buildXlsxTemplate({
      project: { code: "DECI_4TH", name: "DECI — 4th Intake", program: "DECI", intake: "4th Intake", organization_id: 1610 },
      statuses: [{ status: "completed", label: "Completed", class: "closed" }],
      topics: ["Report a Problem / inquiry"],
      generatedAt: new Date("2026-10-23T00:00:00Z"),
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Tickets", "Instructions", "Examples", "Lists"]);
    const tickets = wb.getWorksheet("Tickets")!;
    expect((tickets.getRow(1).values as unknown[]).slice(1)).toEqual([...SOURCE_COLUMNS]);
    expect(tickets.getColumn(1).numFmt).toBe("@");
    expect(tickets.getColumn(SOURCE_COLUMNS.indexOf("Owner_ID") + 1).numFmt).toBe("@");
    const help = wb.getWorksheet("Instructions")!;
    const helpText = help.getSheetValues().flat().join(" ");
    for (const d of COLUMN_DOCS) expect(helpText).toContain(d.column);
    expect(helpText).toContain("Organization_ID 1610");
    expect(helpText).toMatch(/Required/);
    const examples = wb.getWorksheet("Examples")!;
    expect(examples.getRow(2).getCell(SOURCE_COLUMNS.indexOf("Note") + 1).value).toBe(TEMPLATE_EXAMPLE_MARKER);
    expect(String(examples.getRow(2).getCell(SOURCE_COLUMNS.indexOf("Message") + 1).value)).toMatch(/[؀-ۿ]/);
  });

  it("an Excel number that lost precision is a blocking error", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Tickets");
    ws.addRow([...SOURCE_COLUMNS]);
    const row = SOURCE_COLUMNS.map((c) => ({ Ticket_ID: 1234567890123456789, Topic: "Report a Problem / inquiry", Created_At: "2026-09-01 10:00:00 +0300", Organization_ID: 1610 })[c as "Ticket_ID"] ?? null);
    ws.addRow(row);
    const contents = await readUpload(Buffer.from(await wb.xlsx.writeBuffer()), "xlsx");
    expect(contents.cellIssues).toEqual([expect.objectContaining({ severity: "error", code: "ID_PRECISION_LOST", column_name: "Ticket_ID", row_number: 1, line: 2 })]);
  });

  it("refuses a workbook whose data is only on the Examples sheet", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Examples").addRow([...SOURCE_COLUMNS]);
    await expect(readUpload(Buffer.from(await wb.xlsx.writeBuffer()), "xlsx")).rejects.toThrow(/no "Tickets" sheet/);
  });
});

describe("validation report", () => {
  it("is Excel-safe CSV with explanations and formula-injection protection", () => {
    const csvText = validationReportCsv(
      [{ severity: "error", code: "INVALID_TIMESTAMP", row_number: 3, line: 4, ticket_id: 7, column_name: "Created_At", message: "Created_At is not a real date.", value_excerpt: "=HYPERLINK(1)" }],
      { filename: "x.csv", generatedAt: new Date("2026-10-23T00:00:00Z"), omitted: { OFFSET_NOT_CAIRO: 12 } },
    );
    expect(csvText.startsWith("﻿# Validation report")).toBe(true);
    expect(csvText).toContain("Blocking error,INVALID_TIMESTAMP,3,4,7,Created_At");
    expect(csvText).toContain("'=HYPERLINK(1)");
    expect(csvText).toContain("not a real date");
    expect(csvText).toMatch(/# 12 more OFFSET_NOT_CAIRO findings/);
  });
});
