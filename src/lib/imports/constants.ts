import type { SourceColumn } from "@/lib/ingest/columns";

/** Uploads above this size are refused (also enforced by the Storage bucket and in SQL). */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export const IMPORT_BUCKET = "imports";

/** Marker carried by every template example row; rows containing it are always rejected. */
export const TEMPLATE_EXAMPLE_MARKER = "TEMPLATE EXAMPLE - DO NOT IMPORT";

/** Sheet read from an uploaded workbook (falls back to the first data sheet). */
export const DATA_SHEET = "Tickets";
export const NON_DATA_SHEETS = ["Instructions", "Examples", "Lists"];

export type ColumnRequirement = "required" | "recommended" | "optional";

export interface ColumnDoc {
  column: SourceColumn;
  requirement: ColumnRequirement;
  format: string;
  example: string;
  notes: string;
  /** Identifier columns must be formatted as text in Excel so long numbers are not rounded. */
  text: boolean;
}

/** One entry per template column, in the original export order. */
export const COLUMN_DOCS: ColumnDoc[] = [
  { column: "Ticket_ID", requirement: "required", format: "Whole number, up to 15 digits", example: "407898", notes: "Unique within the project. Re-importing an existing ID updates that ticket.", text: true },
  { column: "Topic", requirement: "required", format: "Text", example: "Virtual Session Absence Appeal", notes: "As written in the ticketing system. New topics are imported and can be mapped to a category in Settings → Categories.", text: false },
  { column: "Message", requirement: "optional", format: "Text (Arabic or English, multi-line allowed)", example: "Details: لم أتمكن من دخول الجلسة", notes: "Stored exactly as written. Visible to administrators only.", text: false },
  { column: "Status", requirement: "recommended", format: "Text", example: "completed", notes: "Usually completed, pending or rejected. Other values are imported and flagged until classified as open or closed.", text: false },
  { column: "Priority", requirement: "optional", format: "Text", example: "", notes: "Empty in the current exports.", text: false },
  { column: "Department", requirement: "optional", format: "Text", example: "education", notes: "", text: false },
  { column: "Owner_Type", requirement: "optional", format: "Text", example: "Student", notes: "", text: false },
  { column: "Owner_ID", requirement: "recommended", format: "Identifier (text)", example: "30212310100734", notes: "Student identifier. Keep as text so Excel does not round it.", text: true },
  { column: "Affected_Student_ID", requirement: "optional", format: "Identifier (text)", example: "", notes: "", text: true },
  { column: "Created_At", requirement: "required", format: "YYYY-MM-DD HH:MM:SS +HHMM", example: "2026-09-01 10:15:00 +0300", notes: "Include the UTC offset (+0300 in Egyptian summer time, +0200 in winter). Times without an offset are read as Africa/Cairo time and flagged.", text: true },
  { column: "Responded_At", requirement: "optional", format: "YYYY-MM-DD HH:MM:SS +HHMM", example: "2026-09-01 10:15:02 +0300", notes: "Recorded first response time.", text: true },
  { column: "Resolved_At", requirement: "optional", format: "YYYY-MM-DD HH:MM:SS +HHMM", example: "2026-09-02 13:40:00 +0300", notes: "Empty while the ticket is unresolved.", text: true },
  { column: "Response", requirement: "optional", format: "Text", example: "تم استلام طلبكم بنجاح", notes: "Recorded response text.", text: false },
  { column: "Note", requirement: "optional", format: "Text", example: "", notes: "Internal note. Visible to administrators only.", text: false },
  { column: "Responder_Name", requirement: "optional", format: "Text", example: "support.agent", notes: "", text: false },
  { column: "Resolved_By", requirement: "optional", format: "Text", example: "support.agent", notes: "", text: false },
  { column: "Organization_ID", requirement: "required", format: "Whole number", example: "1610", notes: "Must match the selected project. May be left empty: it is then filled with the project's Organization_ID.", text: true },
  { column: "Attachment_URLs", requirement: "optional", format: "http(s) URLs separated by spaces or new lines", example: "https://api.ischooltech.com/files/receipt.pdf", notes: "Stored as references; files are never downloaded.", text: false },
  { column: "Response_Attachment_URLs", requirement: "optional", format: "http(s) URLs separated by spaces or new lines", example: "", notes: "", text: false },
];

export const ISSUE_SEVERITY_LABELS = { error: "Blocking error", warning: "Warning", info: "Note" } as const;

/** Plain-language explanation for every validation code (validation report + UI). */
export const ISSUE_CODE_HELP: Record<string, string> = {
  FILE_EMPTY: "The file has no content.",
  FILE_TOO_LARGE: "The file exceeds the upload limit.",
  FILE_ENCODING_INVALID: "The file is not UTF-8 encoded; Arabic text would be corrupted.",
  FILE_TYPE_MISMATCH: "The file content does not match its extension.",
  FILE_UNREADABLE: "The file could not be read as a spreadsheet.",
  CSV_PARSE_ERROR: "The CSV structure is broken (unbalanced quotes or a row with the wrong number of columns).",
  HEADER_MISMATCH: "Required template columns are missing.",
  NO_DATA_ROWS: "The file contains a header but no ticket rows.",
  ORGANIZATION_NOT_FOUND: "No row carries the selected project's Organization_ID.",
  EXTRA_COLUMN_IGNORED: "A column that is not part of the template was ignored.",
  VALIDATION_FAILED: "A required value is missing or has the wrong format.",
  INVALID_TICKET_ID: "Ticket_ID must be a whole number of up to 15 digits.",
  MISSING_REQUIRED: "A required value is empty.",
  INVALID_TIMESTAMP: "The date/time is not in the expected format or is not a real date.",
  INVALID_ORGANIZATION_ID: "Organization_ID must be a whole number.",
  UNSUPPORTED_STATUS_FORMAT: "Status must be a short word (letters, spaces, _ or -).",
  ORGANIZATION_MISMATCH: "The row belongs to a different organization than the selected project.",
  DUPLICATE_TICKET_IN_FILE: "The same Ticket_ID appears more than once; the row with the latest activity is kept.",
  TICKET_ID_COLLISION: "The Ticket_ID already belongs to another project of the same reporting cycle.",
  SAMPLE_ROW: "The row is an example copied from the template.",
  ID_PRECISION_LOST: "Excel stored the identifier as a number and may have rounded it.",
  TEXT_ENCODING: "The text contains replacement characters (�): it was corrupted before upload.",
  MOJIBAKE_SUSPECTED: "Arabic text looks garbled (decoded with the wrong encoding).",
  CONTROL_CHARACTERS: "The text contains invisible control characters.",
  TIMESTAMP_ASSUMED_CAIRO: "The time had no UTC offset and was read as Africa/Cairo local time.",
  TIMESTAMP_CONVERTED: "The date/time was converted from another format to the standard format.",
  OFFSET_NOT_CAIRO: "The UTC offset differs from Cairo time on that date (the instant is still exact).",
  TIMESTAMP_ORDER: "Timestamps are out of order (e.g. resolved before created).",
  FUTURE_TIMESTAMP: "A timestamp is in the future.",
  STATUS_TIMESTAMP_MISMATCH: "Status and timestamps disagree (e.g. completed without Resolved_At).",
  STATUS_NOT_CONFIGURED: "Status value not yet classified as open or closed; it counts as open until classified.",
  TOPIC_UNMAPPED: "New topic, not mapped to an analytical category yet (counted as Uncategorized).",
  ATTACHMENT_URL_INVALID: "An attachment value is not an http(s) URL; it is kept but not listed as an attachment.",
  ORGANIZATION_FILLED: "Organization_ID was empty and was set to the selected project's value.",
  UPDATE_REGRESSION: "An update removes information that the stored ticket has; review before confirming.",
  STALE_EXPORT_ROW: "The stored ticket comes from a newer export; this row will not be applied.",
};
