import { z } from "zod";
import { TimestampError, parseSourceTimestamp, type ParsedTimestamp } from "@/lib/ingest/timestamps";

/** Blank (after trimming) → null; otherwise the ORIGINAL string, untouched. */
const verbatimOptional = z.string().transform((v) => (v.trim() === "" ? null : v));

/** Blank → null; otherwise trimmed. Used for identifiers and categorical values. */
const trimmedOptional = z.string().transform((v) => {
  const t = v.trim();
  return t === "" ? null : t;
});

function parseOrIssue(v: string, ctx: z.RefinementCtx): ParsedTimestamp | typeof z.NEVER {
  try {
    return parseSourceTimestamp(v);
  } catch (err) {
    ctx.addIssue({
      code: "custom",
      message: err instanceof TimestampError ? err.message : "invalid timestamp",
    });
    return z.NEVER;
  }
}

const requiredTimestamp = z.string().transform((v, ctx): ParsedTimestamp => {
  if (v.trim() === "") {
    ctx.addIssue({ code: "custom", message: "is required" });
    return z.NEVER;
  }
  return parseOrIssue(v, ctx);
});

const optionalTimestamp = z.string().transform((v, ctx): ParsedTimestamp | null => {
  if (v.trim() === "") return null;
  return parseOrIssue(v, ctx);
});

/**
 * Validation for one raw CSV record. Free text (Message, Response, Note,
 * attachment fields) is preserved byte-for-byte; only blank values become NULL.
 */
export const sourceRowSchema = z.object({
  Ticket_ID: z
    .string()
    .trim()
    .regex(/^[1-9]\d{0,14}$/, "must be a positive integer (max 15 digits)"),
  Topic: z.string().trim().min(1, "is required").max(500, "is too long"),
  Message: verbatimOptional,
  Status: trimmedOptional.refine((v) => v === null || /^[A-Za-z][A-Za-z _-]{0,39}$/.test(v), {
    message: "has an unexpected format",
  }),
  Priority: trimmedOptional,
  Department: trimmedOptional,
  Owner_Type: trimmedOptional,
  Owner_ID: trimmedOptional,
  Affected_Student_ID: trimmedOptional,
  Created_At: requiredTimestamp,
  Responded_At: optionalTimestamp,
  Resolved_At: optionalTimestamp,
  Response: verbatimOptional,
  Note: verbatimOptional,
  Responder_Name: trimmedOptional,
  Resolved_By: trimmedOptional,
  Organization_ID: z.string().trim().regex(/^\d{1,9}$/, "must be a positive integer"),
  Attachment_URLs: verbatimOptional,
  Response_Attachment_URLs: verbatimOptional,
});

export type ValidatedSourceRow = z.output<typeof sourceRowSchema>;

export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "row"} ${i.message}`).join("; ");
}
