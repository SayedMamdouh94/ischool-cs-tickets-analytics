import { createHash } from "node:crypto";
import { SOURCE_COLUMNS, PARSER_VERSION, type SourceRow } from "./columns";
import type { ParsedCsvRecord } from "./csv";
import { parseAttachmentField, type ParsedAttachment } from "./attachments";
import { normalizeSubTopic, parseMessage, type MessageLanguage } from "./message";
import { offsetMatchesCairo } from "./timestamps";
import { formatZodIssues, sourceRowSchema } from "@/lib/validation/ticket-row";

export interface TicketRecord {
  ticket_id: number;
  organization_id: number;
  topic: string;
  message: string | null;
  status: string | null;
  priority: string | null;
  department: string | null;
  owner_type: string | null;
  owner_id: string | null;
  affected_student_id: string | null;
  created_at: string;
  responded_at: string | null;
  resolved_at: string | null;
  response: string | null;
  note: string | null;
  responder_name: string | null;
  resolved_by: string | null;
  attachment_urls: string | null;
  response_attachment_urls: string | null;
  sub_topic: string | null;
  session_ref: string | null;
  lesson_name: string | null;
  message_language: MessageLanguage;
  parser_version: string;
  source_row_number: number;
  row_hash: string;
}

export interface TransformedRow {
  record: TicketRecord;
  attachments: ParsedAttachment[];
  /** Free-text details (used for classification only; never logged). */
  details: string | null;
  createdEpochMs: number;
  respondedEpochMs: number | null;
  resolvedEpochMs: number | null;
  /** Latest timestamp on the row (activity marker). */
  latestEpochMs: number;
  offsets: string[];
  offsetMismatches: number;
  invalidAttachmentTokens: number;
}

export interface RowError {
  rowNumber: number;
  line: number;
  ticketId: number | null;
  code: string;
  message: string;
  raw: SourceRow;
  /** Column the error is about, when it concerns a single column. */
  column?: string;
  /** Per-column problems behind a VALIDATION_FAILED error. */
  issues?: { column: string; message: string }[];
}

/** SHA-256 over the raw source values in canonical column order. */
export function computeRowHash(values: SourceRow): string {
  const h = createHash("sha256");
  for (const col of SOURCE_COLUMNS) {
    h.update(col);
    h.update("\u001f");
    h.update(values[col] ?? "");
    h.update("\u001e");
  }
  return h.digest("hex");
}

export function transformRecord(
  rec: ParsedCsvRecord,
): { ok: true; row: TransformedRow } | { ok: false; error: RowError } {
  const parsed = sourceRowSchema.safeParse(rec.values);
  const idGuess = /^\d{1,15}$/.test(rec.values.Ticket_ID.trim()) ? Number(rec.values.Ticket_ID.trim()) : null;

  if (!parsed.success) {
    return {
      ok: false,
      error: {
        rowNumber: rec.rowNumber,
        line: rec.line,
        ticketId: idGuess,
        code: "VALIDATION_FAILED",
        message: formatZodIssues(parsed.error),
        raw: rec.values,
        issues: parsed.error.issues.map((i) => ({ column: String(i.path[0] ?? "row"), message: i.message })),
      },
    };
  }

  const v = parsed.data;
  const msg = parseMessage(v.Message);
  const req = parseAttachmentField(v.Attachment_URLs, "request");
  const resp = parseAttachmentField(v.Response_Attachment_URLs, "response");

  const stamps = [v.Created_At, v.Responded_At, v.Resolved_At].filter((t) => t !== null);
  const offsetMismatches = stamps.filter((t) => !offsetMatchesCairo(t)).length;

  const record: TicketRecord = {
    ticket_id: Number(v.Ticket_ID),
    organization_id: Number(v.Organization_ID),
    topic: v.Topic,
    message: v.Message,
    status: v.Status,
    priority: v.Priority,
    department: v.Department,
    owner_type: v.Owner_Type,
    owner_id: v.Owner_ID,
    affected_student_id: v.Affected_Student_ID,
    created_at: v.Created_At.iso,
    responded_at: v.Responded_At?.iso ?? null,
    resolved_at: v.Resolved_At?.iso ?? null,
    response: v.Response,
    note: v.Note,
    responder_name: v.Responder_Name,
    resolved_by: v.Resolved_By,
    attachment_urls: v.Attachment_URLs,
    response_attachment_urls: v.Response_Attachment_URLs,
    sub_topic: normalizeSubTopic(msg.subTopic),
    session_ref: msg.sessionRef,
    lesson_name: msg.lessonName,
    message_language: msg.language,
    parser_version: PARSER_VERSION,
    source_row_number: rec.rowNumber,
    row_hash: computeRowHash(rec.values),
  };

  return {
    ok: true,
    row: {
      record,
      attachments: [...req.attachments, ...resp.attachments],
      details: msg.details,
      createdEpochMs: v.Created_At.epochMs,
      respondedEpochMs: v.Responded_At?.epochMs ?? null,
      resolvedEpochMs: v.Resolved_At?.epochMs ?? null,
      latestEpochMs: Math.max(...stamps.map((t) => t.epochMs)),
      offsets: stamps.map((t) => t.offsetToken),
      offsetMismatches,
      invalidAttachmentTokens: req.invalidTokens + resp.invalidTokens,
    },
  };
}
