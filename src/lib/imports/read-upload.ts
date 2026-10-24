import ExcelJS from "exceljs";
import { SOURCE_COLUMNS, type SourceColumn, type SourceRow } from "@/lib/ingest/columns";
import { CsvStructureError, decodeCsv, parseTicketCsv, resolveHeader, type ParsedCsv, type ParsedCsvRecord } from "@/lib/ingest/csv";
import { COLUMN_DOCS, DATA_SHEET, NON_DATA_SHEETS } from "./constants";
import { excelDateToWallClock } from "./normalize";
import type { ImportIssue } from "./validate";

export type UploadFormat = "csv" | "xlsx";

export interface UploadContents {
  parsed: ParsedCsv;
  format: UploadFormat;
  sheet?: string;
  delimiter?: string;
  /** File-level findings (ignored columns, extra sheets). */
  fileIssues: ImportIssue[];
  /** Cell-level findings from the spreadsheet conversion (e.g. rounded identifiers). */
  cellIssues: ImportIssue[];
  /** Cells converted from Excel dates (row number → columns). */
  excelDates: Map<number, SourceColumn[]>;
}

const TEXT_COLUMNS = new Set(COLUMN_DOCS.filter((d) => d.text).map((d) => d.column));
const ID_COLUMNS = new Set<SourceColumn>(["Ticket_ID", "Owner_ID", "Affected_Student_ID", "Organization_ID"]);
const MAX_EXACT_ID = 999_999_999_999_999; // 15 digits: Excel keeps at most 15 significant digits

/** Reads a CSV or Excel upload into the same record structure. Throws CsvStructureError for file-level problems. */
export async function readUpload(buffer: Buffer, format: UploadFormat): Promise<UploadContents> {
  if (buffer.length === 0) throw new CsvStructureError("The file is empty.", "FILE_EMPTY");
  if (format === "csv") {
    const { text, delimiter } = decodeCsv(buffer);
    const parsed = parseTicketCsv(text, { delimiter, lenientHeader: true, allowReplacementChars: true });
    return {
      parsed,
      format,
      delimiter,
      fileIssues: ignoredColumnIssues(parsed.ignoredColumns),
      cellIssues: [],
      excelDates: new Map(),
    };
  }
  return readXlsx(buffer);
}

function ignoredColumnIssues(columns: string[]): ImportIssue[] {
  return columns.map((c) => ({
    severity: "warning" as const,
    code: "EXTRA_COLUMN_IGNORED",
    column_name: c.slice(0, 60) || "(blank header)",
    message: `Column "${c.slice(0, 60)}" is not part of the template and was ignored.`,
  }));
}

type CellValue = ExcelJS.CellValue;

function cellToString(value: CellValue): { text: string; date?: boolean; number?: number } {
  if (value === null || value === undefined) return { text: "" };
  if (typeof value === "string") return { text: value };
  if (typeof value === "number") return { text: Number.isInteger(value) ? String(value) : String(value), number: value };
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE" };
  if (value instanceof Date) return { text: excelDateToWallClock(value), date: true };
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) return { text: value.richText.map((r) => r.text).join("") };
    if ("result" in value) return cellToString((value as { result?: CellValue }).result ?? null);
    if ("text" in value && typeof (value as { text: unknown }).text === "string") return { text: (value as { text: string }).text };
    if ("hyperlink" in value) return { text: String((value as { hyperlink: string }).hyperlink) };
    if ("error" in value) return { text: "" };
  }
  return { text: String(value) };
}

async function readXlsx(buffer: Buffer): Promise<UploadContents> {
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    throw new CsvStructureError("The file is not a valid .xlsx workbook. Save it as \"Excel Workbook (.xlsx)\" or as CSV UTF-8.", "FILE_TYPE_MISMATCH");
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (err) {
    throw new CsvStructureError(`The workbook could not be read (${(err as Error).message.slice(0, 120)}).`, "FILE_UNREADABLE");
  }
  const sheet =
    workbook.getWorksheet(DATA_SHEET) ?? workbook.worksheets.find((w) => !NON_DATA_SHEETS.includes(w.name) && w.actualRowCount > 0);
  if (!sheet) {
    throw new CsvStructureError(`The workbook has no "${DATA_SHEET}" sheet with data. Paste the tickets into the "${DATA_SHEET}" sheet of the template.`, "NO_DATA_ROWS");
  }

  const fileIssues: ImportIssue[] = [];
  const otherSheets = workbook.worksheets.filter((w) => w !== sheet && !NON_DATA_SHEETS.includes(w.name) && w.actualRowCount > 0);
  for (const w of otherSheets) {
    fileIssues.push({
      severity: "warning",
      code: "EXTRA_COLUMN_IGNORED",
      column_name: `sheet ${w.name}`.slice(0, 60),
      message: `Only the "${sheet.name}" sheet is imported; sheet "${w.name}" was ignored.`,
    });
  }

  // Header: first row with any value.
  let headerRow = 0;
  let header: string[] = [];
  const maxCol = Math.max(sheet.actualColumnCount, sheet.columnCount, SOURCE_COLUMNS.length);
  sheet.eachRow({ includeEmpty: false }, (row, n) => {
    if (headerRow) return;
    const cells = Array.from({ length: maxCol }, (_, i) => cellToString(row.getCell(i + 1).value).text.trim());
    if (cells.some((c) => c !== "")) {
      headerRow = n;
      header = cells;
    }
  });
  if (!headerRow) throw new CsvStructureError("The sheet is empty.", "FILE_EMPTY");
  while (header.length > 0 && header[header.length - 1] === "") header.pop();
  const { index, ignored } = resolveHeader(header, { lenient: true });
  fileIssues.push(...ignoredColumnIssues(ignored));

  const records: ParsedCsvRecord[] = [];
  const cellIssues: ImportIssue[] = [];
  const excelDates = new Map<number, SourceColumn[]>();
  sheet.eachRow({ includeEmpty: false }, (row, n) => {
    if (n <= headerRow) return;
    const values = {} as SourceRow;
    let any = false;
    const pendingIssues: ImportIssue[] = [];
    const dates: SourceColumn[] = [];
    for (const col of SOURCE_COLUMNS) {
      const cell = cellToString(row.getCell(index.get(col)! + 1).value);
      let text = cell.text;
      if (cell.number !== undefined && ID_COLUMNS.has(col)) {
        if (!Number.isInteger(cell.number) || Math.abs(cell.number) > MAX_EXACT_ID) {
          pendingIssues.push({
            severity: "error",
            code: "ID_PRECISION_LOST",
            line: n,
            column_name: col,
            message: `${col} was stored by Excel as a number (${cell.number}) and may have been rounded. Format the column as Text and re-enter the value.`,
          });
        }
        text = Number.isInteger(cell.number) ? BigInt(Math.trunc(cell.number)).toString() : String(cell.number);
      }
      if (cell.date) {
        if (TEXT_COLUMNS.has(col) && /_At$/.test(col)) dates.push(col);
      }
      values[col] = text;
      if (text.trim() !== "") any = true;
    }
    if (!any) return;
    const rowNumber = records.length + 1;
    records.push({ rowNumber, line: n, values });
    for (const issue of pendingIssues) cellIssues.push({ ...issue, row_number: rowNumber });
    if (dates.length > 0) excelDates.set(rowNumber, dates);
  });

  return { parsed: { header, records, ignoredColumns: ignored }, format: "xlsx", sheet: sheet.name, fileIssues, cellIssues, excelDates };
}
