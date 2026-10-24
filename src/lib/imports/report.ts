import { csvEscape } from "@/lib/table-data";
import { ISSUE_CODE_HELP, ISSUE_SEVERITY_LABELS } from "./constants";

export interface ReportIssue {
  severity: "error" | "warning" | "info";
  code: string;
  row_number: number | null;
  line: number | null;
  ticket_id: number | null;
  column_name: string | null;
  message: string;
  value_excerpt: string | null;
}

const REPORT_COLUMNS = ["Severity", "Code", "Row", "Line in file", "Ticket_ID", "Column", "Problem", "Value", "Explanation"];

/** Validation report as CSV (UTF-8 with BOM for Excel). Row = data row number, Line = line/sheet row in the file. */
export function validationReportCsv(issues: ReportIssue[], header: { filename: string; generatedAt: Date; omitted?: Record<string, number> }): string {
  const lines = [
    `# Validation report for ${header.filename.replace(/[\r\n]/g, " ")} — generated ${header.generatedAt.toISOString()}`,
    REPORT_COLUMNS.join(","),
    ...issues.map((i) =>
      [
        ISSUE_SEVERITY_LABELS[i.severity],
        i.code,
        i.row_number,
        i.line,
        i.ticket_id,
        i.column_name,
        i.message,
        i.value_excerpt,
        ISSUE_CODE_HELP[i.code] ?? "",
      ]
        .map((v) => csvEscape(v ?? null))
        .join(","),
    ),
  ];
  for (const [code, n] of Object.entries(header.omitted ?? {})) {
    if (n > 0) lines.push(`# ${n} more ${code} findings are counted in the summary but not listed individually.`);
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
