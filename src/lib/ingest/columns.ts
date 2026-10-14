/** The 19 columns present in every ticket export, in source order. */
export const SOURCE_COLUMNS = [
  "Ticket_ID",
  "Topic",
  "Message",
  "Status",
  "Priority",
  "Department",
  "Owner_Type",
  "Owner_ID",
  "Affected_Student_ID",
  "Created_At",
  "Responded_At",
  "Resolved_At",
  "Response",
  "Note",
  "Responder_Name",
  "Resolved_By",
  "Organization_ID",
  "Attachment_URLs",
  "Response_Attachment_URLs",
] as const;

export type SourceColumn = (typeof SOURCE_COLUMNS)[number];
export type SourceRow = Record<SourceColumn, string>;

export const IMPORTER_VERSION = "1.0.0";
export const PARSER_VERSION = "msg-v1";

/**
 * Update policy applied when a ticket already exists (documented in docs/DATA_IMPORT.md):
 * a row is updated only if its content changed AND the export it comes from is
 * at least as recent (data_as_of) as the export that last wrote the ticket.
 */
export const UPDATE_POLICY = "newer-or-equal-export-wins:v1";
