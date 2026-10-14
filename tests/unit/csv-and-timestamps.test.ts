import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CsvStructureError, parseTicketCsv } from "@/lib/ingest/csv";
import { SOURCE_COLUMNS } from "@/lib/ingest/columns";
import { cairoOffsetMinutes, offsetMatchesCairo, parseOptionalTimestamp, parseSourceTimestamp, TimestampError } from "@/lib/ingest/timestamps";

const fixture = readFileSync(path.join(__dirname, "../fixtures/sample.csv"));

describe("parseTicketCsv", () => {
  it("strips the UTF-8 BOM and reads all 19 columns", () => {
    const parsed = parseTicketCsv(fixture);
    expect(parsed.header).toEqual([...SOURCE_COLUMNS]);
    expect(parsed.records).toHaveLength(3);
    expect(Object.keys(parsed.records[0].values)).toEqual([...SOURCE_COLUMNS]);
  });

  it("preserves multiline quoted values, embedded commas, quotes and Arabic text exactly", () => {
    const [first] = parseTicketCsv(fixture).records;
    expect(first.values.Message).toBe(
      "Sub Topic: مشكلة أو استفسار غير مرتبط بالجلسة الجارية الآن\nDetails: انا كنت حاضر ومكتوب غياب, ارجو التصحيح",
    );
    expect(first.values.Note).toBe('مرحبًا عميلنا العزيز،\nتم التصحيح "بنجاح"');
    expect(first.values.Priority).toBe("");
  });

  it("numbers records by data row and tracks their first physical line", () => {
    const { records } = parseTicketCsv(fixture);
    expect(records.map((r) => r.rowNumber)).toEqual([1, 2, 3]);
    expect(records[0].line).toBe(2);
    // Record 1 spans lines 2–4 (one newline in the message, one in the note), so record 2 starts on line 5.
    expect(records[1].line).toBe(5);
  });

  it("rejects files whose header does not match the export format", () => {
    expect(() => parseTicketCsv("Ticket_ID,Topic\n1,x\n")).toThrow(CsvStructureError);
  });

  it("rejects rows with a wrong number of columns instead of guessing", () => {
    const header = SOURCE_COLUMNS.join(",");
    expect(() => parseTicketCsv(`${header}\n1,2,3\n`)).toThrow(CsvStructureError);
  });

  it("rejects invalid UTF-8", () => {
    const bad = Buffer.concat([Buffer.from(`${SOURCE_COLUMNS.join(",")}\n`), Buffer.from([0xff, 0xfe, 0x0a])]);
    expect(() => parseTicketCsv(bad)).toThrow(/UTF-8/);
  });
});

describe("timestamps", () => {
  it("parses +0300 and +0200 offsets into absolute instants", () => {
    const summer = parseSourceTimestamp("2026-09-01 00:08:39 +0300");
    expect(summer.iso).toBe("2026-09-01T00:08:39+03:00");
    expect(new Date(summer.epochMs).toISOString()).toBe("2026-08-31T21:08:39.000Z");
    const winter = parseSourceTimestamp("2026-04-14 16:56:23 +0200");
    expect(new Date(winter.epochMs).toISOString()).toBe("2026-04-14T14:56:23.000Z");
    expect(winter.offsetToken).toBe("+0200");
  });

  it("rejects malformed and impossible timestamps", () => {
    for (const bad of ["2026-09-01", "2026-09-01T00:08:39Z", "2026-02-30 10:00:00 +0200", "2026-13-01 10:00:00 +0200", "2026-09-01 24:00:00 +0300"]) {
      expect(() => parseSourceTimestamp(bad), bad).toThrow(TimestampError);
    }
  });

  it("treats blanks as missing (never fabricates a timestamp)", () => {
    expect(parseOptionalTimestamp("")).toBeNull();
    expect(parseOptionalTimestamp("   ")).toBeNull();
    expect(parseOptionalTimestamp(undefined)).toBeNull();
  });

  it("knows Egypt's daylight-saving offsets", () => {
    expect(cairoOffsetMinutes(Date.UTC(2026, 0, 15))).toBe(120);
    expect(cairoOffsetMinutes(Date.UTC(2026, 6, 15))).toBe(180);
    expect(offsetMatchesCairo(parseSourceTimestamp("2026-07-15 12:00:00 +0300"))).toBe(true);
    expect(offsetMatchesCairo(parseSourceTimestamp("2026-07-15 12:00:00 +0200"))).toBe(false);
  });
});
