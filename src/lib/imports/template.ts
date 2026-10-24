import ExcelJS from "exceljs";
import { SOURCE_COLUMNS } from "@/lib/ingest/columns";
import { COLUMN_DOCS, DATA_SHEET, MAX_IMPORT_BYTES, TEMPLATE_EXAMPLE_MARKER, type ColumnRequirement } from "./constants";

/**
 * Downloadable import templates. The data sheet has exactly the 19 export
 * columns in their original order; instructions and examples live on separate
 * sheets that the importer never reads (and example rows carry a marker that
 * the validator rejects even if copied over).
 */

export interface TemplateProject {
  code: string;
  name: string;
  program: string;
  intake: string;
  organization_id: number;
}

export interface TemplateOptions {
  project?: TemplateProject | null;
  statuses: { status: string; label: string; class: "open" | "closed" }[];
  topics: string[];
  generatedAt: Date;
}

const REQUIREMENT_LABEL: Record<ColumnRequirement, string> = { required: "Required", recommended: "Recommended", optional: "Optional" };
const HEADER_FILL: Record<ColumnRequirement, string> = { required: "FF1F3A5F", recommended: "FF3B6A9C", optional: "FF8A99AD" };
const DATA_ROWS = 20000;

/** CSV template: UTF-8 with BOM (so Excel shows Arabic correctly), header only. */
export function buildCsvTemplate(): string {
  return `﻿${SOURCE_COLUMNS.join(",")}\r\n`;
}

function exampleRows(org: number): Record<string, string>[] {
  const base = Object.fromEntries(SOURCE_COLUMNS.map((c) => [c, ""])) as Record<string, string>;
  return [
    {
      ...base,
      Ticket_ID: "900000001",
      Topic: "Virtual Session Absence Appeal",
      Message: "Session ID: 5859718, Lesson: Introduction to Python, Start: 2026-09-01 18:00, End: 19:30, Details: كنت حاضر الجلسة لكن تم تسجيلي غياب",
      Status: "completed",
      Department: "education",
      Owner_Type: "Student",
      Owner_ID: "30212310100734",
      Created_At: "2026-09-01 20:05:11 +0300",
      Responded_At: "2026-09-01 20:05:12 +0300",
      Resolved_At: "2026-09-02 13:40:00 +0300",
      Response: "تم استلام طلبكم بنجاح",
      Note: TEMPLATE_EXAMPLE_MARKER,
      Responder_Name: "support.agent",
      Resolved_By: "support.agent",
      Organization_ID: String(org),
    },
    {
      ...base,
      Ticket_ID: "900000002",
      Topic: "Report a Problem / inquiry",
      Message: "Sub Topic: Not related to the session currently in progress\nDetails: I cannot open the platform since yesterday.",
      Status: "pending",
      Department: "education",
      Owner_Type: "Student",
      Owner_ID: "30109250102188",
      Created_At: "2026-12-03 09:12:45 +0200",
      Responded_At: "2026-12-03 09:12:46 +0200",
      Note: TEMPLATE_EXAMPLE_MARKER,
      Organization_ID: String(org),
      Attachment_URLs: "https://api.ischooltech.com/files/screenshot.png",
    },
    {
      ...base,
      Ticket_ID: "900000003",
      Topic: "Change Student Information",
      Message: "Info Type: Phone number, Details: أرجو تعديل رقم الهاتف",
      Status: "rejected",
      Owner_Type: "Student",
      Owner_ID: "30305140104421",
      Created_At: "2026-10-15 11:00:00 +0300",
      Resolved_At: "2026-10-16 08:30:00 +0300",
      Note: TEMPLATE_EXAMPLE_MARKER,
      Resolved_By: "support.lead",
      Organization_ID: "",
    },
  ];
}

function styleHeader(row: ExcelJS.Row): void {
  row.height = 30;
  row.eachCell((cell, col) => {
    const doc = COLUMN_DOCS[col - 1];
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    if (doc) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL[doc.requirement] } };
  });
}

function setupDataColumns(sheet: ExcelJS.Worksheet): void {
  sheet.columns = COLUMN_DOCS.map((d) => ({
    key: d.column,
    width: d.column === "Message" || d.column === "Response" || d.column === "Note" ? 48 : d.column.endsWith("_At") ? 26 : Math.max(14, d.column.length + 4),
    // Every column is stored as text so Excel never rounds IDs or reformats dates.
    style: { numFmt: "@", alignment: { vertical: "top", wrapText: d.column === "Message" } },
  }));
}

export async function buildXlsxTemplate(opts: TemplateOptions): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CS Tickets Analytics";
  wb.created = opts.generatedAt;
  wb.title = opts.project ? `Ticket import template — ${opts.project.name}` : "Ticket import template";
  const org = opts.project?.organization_id ?? 1610;

  // ---- Tickets (the only sheet that is imported) ---------------------------
  const data = wb.addWorksheet(DATA_SHEET, { views: [{ state: "frozen", ySplit: 1 }], properties: { tabColor: { argb: "FF1F3A5F" } } });
  setupDataColumns(data);
  const header = data.addRow([...SOURCE_COLUMNS]);
  styleHeader(header);
  header.eachCell((cell, col) => {
    const d = COLUMN_DOCS[col - 1];
    cell.note = {
      texts: [{ text: `${REQUIREMENT_LABEL[d.requirement]} · ${d.format}${d.notes ? `\n${d.notes}` : ""}${d.example ? `\nExample: ${d.example}` : ""}` }],
    };
  });
  const statusCol = SOURCE_COLUMNS.indexOf("Status") + 1;
  const orgCol = SOURCE_COLUMNS.indexOf("Organization_ID") + 1;
  for (let r = 2; r <= DATA_ROWS; r++) {
    if (opts.statuses.length > 0) {
      data.getCell(r, statusCol).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`Lists!$A$2:$A$${opts.statuses.length + 1}`],
        showErrorMessage: true,
        errorStyle: "warning",
        errorTitle: "Status not in the list",
        error: "This status is not configured yet. It will be imported and flagged until an administrator classifies it.",
      };
    }
    if (opts.project) {
      data.getCell(r, orgCol).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`"${opts.project.organization_id}"`],
        showErrorMessage: true,
        errorStyle: "stop",
        errorTitle: "Wrong Organization_ID",
        error: `This template is for ${opts.project.name}: Organization_ID must be ${opts.project.organization_id} (or empty).`,
      };
    }
  }

  // ---- Instructions ---------------------------------------------------------
  const help = wb.addWorksheet("Instructions", { properties: { tabColor: { argb: "FF3B6A9C" } } });
  help.columns = [{ width: 26 }, { width: 14 }, { width: 34 }, { width: 34 }, { width: 80 }];
  const title = help.addRow(["CS ticket import template"]);
  title.font = { bold: true, size: 16 };
  help.addRow([`Generated ${opts.generatedAt.toISOString().slice(0, 10)}${opts.project ? ` for ${opts.project.name} (${opts.project.code}) · Program ${opts.project.program} · Intake ${opts.project.intake} · Organization_ID ${opts.project.organization_id}` : ""}`]);
  help.addRow([]);
  const steps = [
    `1. Paste or type the tickets into the "${DATA_SHEET}" sheet, one ticket per row, keeping the header row unchanged.`,
    "2. Keep all 19 columns in this order (the same as the ticketing-system export). Optional columns may stay empty.",
    "3. Every column is formatted as Text. Keep it that way so long IDs are not rounded and dates are not reformatted.",
    "4. Write dates as YYYY-MM-DD HH:MM:SS +HHMM (e.g. 2026-09-01 10:15:00 +0300). Times without an offset are read as Cairo time and flagged.",
    "5. Organization_ID may be left empty: it is filled with the selected project's value. A different value rejects the row.",
    "6. The Examples sheet shows valid rows. It is never imported, and example rows are rejected even if copied into the Tickets sheet.",
    "7. Upload in Settings & Imports → Imports as .xlsx, or save as \"CSV UTF-8 (Comma delimited)\" to keep Arabic text intact.",
    `8. Maximum file size: ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB. Larger exports can be split (e.g. by month) and imported one after another.`,
    "9. Before anything is written you will see a preview (new / updated / unchanged / invalid) and must confirm.",
    "10. Re-importing the same file changes nothing. Tickets missing from a later export are kept, never deleted.",
    "11. A row is applied only if its export is at least as recent as the one that last updated that ticket (older exports never overwrite newer data).",
  ];
  for (const s of steps) help.addRow([s]).getCell(1).alignment = { wrapText: false };
  help.addRow([]);
  const legend = help.addRow(["Header colours:", "Required", "Recommended", "Optional"]);
  (["required", "recommended", "optional"] as ColumnRequirement[]).forEach((req, i) => {
    const cell = legend.getCell(i + 2);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL[req] } };
    cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
  });
  help.addRow([]);
  const tableHeader = help.addRow(["Column", "Required?", "Format", "Example", "Notes"]);
  tableHeader.font = { bold: true };
  tableHeader.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE4EAF2" } }));
  for (const d of COLUMN_DOCS) {
    const row = help.addRow([d.column, REQUIREMENT_LABEL[d.requirement], d.format, d.column === "Organization_ID" ? String(org) : d.example, d.notes]);
    row.alignment = { vertical: "top", wrapText: true };
  }
  help.addRow([]);
  help.addRow(["Valid statuses"]).font = { bold: true };
  for (const s of opts.statuses) help.addRow([s.status === "__none__" ? "(empty)" : s.status, s.class === "open" ? "Open" : "Closed", s.label]);

  // ---- Examples (never imported) ---------------------------------------------
  const ex = wb.addWorksheet("Examples", { views: [{ state: "frozen", ySplit: 1 }], properties: { tabColor: { argb: "FFB45309" } } });
  setupDataColumns(ex);
  styleHeader(ex.addRow([...SOURCE_COLUMNS]));
  for (const row of exampleRows(org)) ex.addRow(SOURCE_COLUMNS.map((c) => row[c]));
  ex.addRow([]);
  ex.addRow([`Examples only. This sheet is ignored by the importer, and rows containing "${TEMPLATE_EXAMPLE_MARKER}" are always rejected.`]).font = { italic: true, color: { argb: "FFB45309" } };

  // ---- Lists (reference values) ----------------------------------------------
  const lists = wb.addWorksheet("Lists", { properties: { tabColor: { argb: "FF8A99AD" } } });
  lists.columns = [{ width: 22 }, { width: 12 }, { width: 70 }];
  lists.addRow(["Status", "Counts as", "Known topics (new topics are allowed)"]).font = { bold: true };
  const maxRows = Math.max(opts.statuses.length, opts.topics.length);
  for (let i = 0; i < maxRows; i++) {
    const s = opts.statuses[i];
    lists.addRow([s ? (s.status === "__none__" ? "" : s.status) : null, s ? s.class : null, opts.topics[i] ?? null]);
  }

  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 0, visibility: "visible" }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
