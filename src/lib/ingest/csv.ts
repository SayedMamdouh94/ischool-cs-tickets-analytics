import { parse } from "csv-parse/sync";
import { SOURCE_COLUMNS, type SourceColumn, type SourceRow } from "./columns";

export interface ParsedCsvRecord {
  /** 1-based index of the data record (header excluded). */
  rowNumber: number;
  /** First physical line of the record in the file (records may span many lines); spreadsheet row for Excel. */
  line: number;
  values: SourceRow;
}

export interface ParsedCsv {
  header: string[];
  records: ParsedCsvRecord[];
  /** Columns present in the file that are not part of the template (lenient mode only). */
  ignoredColumns: string[];
}

export class CsvStructureError extends Error {
  constructor(
    message: string,
    readonly code: string = "FILE_STRUCTURE_INVALID",
  ) {
    super(message);
  }
}

export class HeaderMismatchError extends CsvStructureError {
  constructor(
    readonly missing: string[],
    readonly unexpected: string[],
  ) {
    super(`Header mismatch. Missing: [${missing.join(", ")}]; unexpected: [${unexpected.join(", ")}]`, "HEADER_MISMATCH");
  }
}

const canonicalName = (h: string) => h.trim().toLowerCase().replace(/[\s_-]+/g, "_");
const CANONICAL = new Map(SOURCE_COLUMNS.map((c) => [canonicalName(c), c]));

/**
 * Maps header cells to the 19 template columns. Strict mode (CLI, original
 * behaviour) requires exactly the template names; lenient mode (web imports)
 * also accepts case/spacing variants ("ticket id") and ignores extra columns,
 * which are reported back. Missing columns always fail.
 */
export function resolveHeader(header: string[], opts: { lenient?: boolean } = {}): { index: Map<SourceColumn, number>; ignored: string[] } {
  const index = new Map<SourceColumn, number>();
  const unexpected: string[] = [];
  header.forEach((raw, i) => {
    const h = raw.trim();
    const exact = (SOURCE_COLUMNS as readonly string[]).includes(h) ? (h as SourceColumn) : undefined;
    const col = exact ?? (opts.lenient ? CANONICAL.get(canonicalName(h)) : undefined);
    if (col && !index.has(col)) index.set(col, i);
    else if (h !== "" || !opts.lenient) unexpected.push(h);
  });
  const missing = SOURCE_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0 || (!opts.lenient && unexpected.length > 0)) {
    throw new HeaderMismatchError(missing, unexpected);
  }
  return { index, ignored: unexpected };
}

export interface DecodedText {
  text: string;
  delimiter: "," | ";" | "\t";
}

/**
 * Decodes an uploaded CSV and detects its delimiter. Rejects encodings that
 * would corrupt Arabic text instead of guessing: Excel's "CSV (Comma
 * delimited)" on Arabic Windows saves Windows-1256, which is not UTF-8.
 */
export function decodeCsv(buffer: Buffer): DecodedText {
  if (buffer.length === 0) throw new CsvStructureError("The file is empty.", "FILE_EMPTY");
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)) {
    throw new CsvStructureError(
      'The file is saved as UTF-16 ("Unicode Text"). Save it as "CSV UTF-8 (Comma delimited)" and upload it again.',
      "FILE_ENCODING_INVALID",
    );
  }
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    throw new CsvStructureError("This looks like an Excel workbook renamed to .csv. Upload it with the .xlsx extension.", "FILE_TYPE_MISMATCH");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new CsvStructureError(
      'The file is not valid UTF-8, so Arabic text would be corrupted. In Excel use "Save As → CSV UTF-8 (Comma delimited)", or upload the .xlsx file instead.',
      "FILE_ENCODING_INVALID",
    );
  }
  if (text.includes("\u0000")) throw new CsvStructureError("The file contains binary data and is not a CSV export.", "FILE_TYPE_MISMATCH");
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const counts = { ",": firstLine.split(",").length, ";": firstLine.split(";").length, "\t": firstLine.split("\t").length };
  const delimiter = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] ?? ",") as DecodedText["delimiter"];
  return { text, delimiter: counts[delimiter] > 1 ? delimiter : "," };
}

/**
 * Strict RFC-4180 parsing: UTF-8 with optional BOM, quoted fields that may
 * contain commas, quotes and embedded newlines (CRLF or LF). Values are kept
 * exactly as written — no trimming, no type casting.
 */
export function parseTicketCsv(
  input: Buffer | string,
  opts: { delimiter?: string; lenientHeader?: boolean; allowReplacementChars?: boolean } = {},
): ParsedCsv {
  const text = typeof input === "string" ? input : input.toString("utf8");
  // A raw Buffer decoded with replacement characters means the file was not UTF-8.
  // (Web uploads are decoded strictly first; a "�" that survives is reported per row.)
  if (!opts.allowReplacementChars && text.includes("�")) {
    throw new CsvStructureError("File is not valid UTF-8 (replacement characters found).", "FILE_ENCODING_INVALID");
  }

  let rows: { record: string[]; info: { lines: number } }[];
  try {
    rows = parse(text, {
      bom: true,
      columns: false,
      delimiter: opts.delimiter ?? ",",
      relax_column_count: false,
      relax_quotes: false,
      skip_empty_lines: true,
      info: true,
    }) as unknown as { record: string[]; info: { lines: number } }[];
  } catch (err) {
    throw new CsvStructureError(`CSV parse error: ${(err as Error).message}`, "CSV_PARSE_ERROR");
  }

  if (rows.length === 0) {
    throw new CsvStructureError("File is empty.", "FILE_EMPTY");
  }

  const header = rows[0].record.map((h) => h.trim());
  const { index, ignored } = resolveHeader(header, { lenient: opts.lenientHeader });

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

  return { header, records, ignoredColumns: ignored };
}
