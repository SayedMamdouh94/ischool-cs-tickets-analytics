import { fmtCalendarDate, fmtDateTime, fmtDuration, fmtInt, fmtPct } from "@/lib/format";

export type ColumnKind = "text" | "int" | "pct" | "duration" | "date" | "datetime" | "hours";

export interface TableColumn {
  key: string;
  label: string;
  kind?: ColumnKind;
}

export type CellValue = string | number | boolean | null;

export interface TableData {
  columns: TableColumn[];
  rows: Record<string, CellValue>[];
}

export function formatCell(value: CellValue, kind: ColumnKind = "text"): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  switch (kind) {
    case "int":
      return fmtInt(Number(value));
    case "pct":
      return fmtPct(Number(value));
    case "duration":
      return fmtDuration(Number(value));
    case "hours":
      return `${Number(value).toFixed(1)} h`;
    case "date":
      return fmtCalendarDate(String(value));
    case "datetime":
      return fmtDateTime(String(value));
    default:
      return String(value);
  }
}

export function isNumericKind(kind: ColumnKind | undefined): boolean {
  return kind === "int" || kind === "pct" || kind === "duration" || kind === "hours";
}

/**
 * RFC-4180 CSV with formula-injection protection: cells beginning with
 * = + - @ (or tab/CR) are prefixed with an apostrophe so spreadsheet apps do
 * not execute them. A UTF-8 BOM keeps Arabic text intact in Excel.
 */
export function csvEscape(value: CellValue): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(table: TableData, opts: { bom?: boolean } = {}): string {
  const header = table.columns.map((c) => csvEscape(c.label)).join(",");
  const lines = table.rows.map((r) => table.columns.map((c) => csvEscape(r[c.key] ?? null)).join(","));
  return `${opts.bom === false ? "" : "﻿"}${[header, ...lines].join("\r\n")}\r\n`;
}
