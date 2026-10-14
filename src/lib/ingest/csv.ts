import { parse } from "csv-parse/sync";
import { SOURCE_COLUMNS, type SourceRow } from "./columns";

export interface ParsedCsvRecord {
  /** 1-based index of the data record (header excluded). */
  rowNumber: number;
  /** First physical line of the record in the file (records may span many lines). */
  line: number;
  values: SourceRow;
}

export interface ParsedCsv {
  header: string[];
  records: ParsedCsvRecord[];
}

export class CsvStructureError extends Error {}

/**
 * Strict RFC-4180 parsing: UTF-8 with optional BOM, quoted fields that may
 * contain commas, quotes and embedded newlines (CRLF or LF). Values are kept
 * exactly as written — no trimming, no type casting.
 */
export function parseTicketCsv(input: Buffer | string): ParsedCsv {
  const text = typeof input === "string" ? input : input.toString("utf8");
  if (text.includes("�")) {
    throw new CsvStructureError("File is not valid UTF-8 (replacement characters found).");
  }

  let rows: { record: string[]; info: { lines: number } }[];
  try {
    rows = parse(text, {
      bom: true,
      columns: false,
      relax_column_count: false,
      relax_quotes: false,
      skip_empty_lines: true,
      info: true,
    }) as unknown as { record: string[]; info: { lines: number } }[];
  } catch (err) {
    throw new CsvStructureError(`CSV parse error: ${(err as Error).message}`);
  }

  if (rows.length === 0) {
    throw new CsvStructureError("File is empty.");
  }

  const header = rows[0].record.map((h) => h.trim());
  const missing = SOURCE_COLUMNS.filter((c) => !header.includes(c));
  const unexpected = header.filter((h) => !(SOURCE_COLUMNS as readonly string[]).includes(h));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new CsvStructureError(
      `Header mismatch. Missing: [${missing.join(", ")}]; unexpected: [${unexpected.join(", ")}]`,
    );
  }
  const index = new Map(header.map((h, i) => [h, i]));

  const records: ParsedCsvRecord[] = [];
  let previousEndLine = rows[0].info.lines;
  for (let i = 1; i < rows.length; i++) {
    const { record, info } = rows[i];
    const values = {} as SourceRow;
    for (const col of SOURCE_COLUMNS) {
      values[col] = record[index.get(col)!] ?? "";
    }
    records.push({ rowNumber: i, line: previousEndLine + 1, values });
    previousEndLine = info.lines;
  }

  return { header, records };
}
