export type AttachmentType = "request" | "response";

export interface ParsedAttachment {
  attachmentType: AttachmentType;
  position: number;
  url: string;
  host: string | null;
  fileName: string | null;
  extension: string | null;
}

export interface AttachmentParseResult {
  attachments: ParsedAttachment[];
  /** Tokens that were not valid http(s) URLs (kept in the raw field, not normalized). */
  invalidTokens: number;
}

/**
 * Splits an attachment field into individual URLs. Exports currently hold at
 * most one URL per field, but whitespace-, newline-, comma- or semicolon-
 * separated lists are supported. URLs are stored as references only — they
 * are never fetched.
 */
export function parseAttachmentField(raw: string | null | undefined, type: AttachmentType): AttachmentParseResult {
  if (raw == null || raw.trim() === "") return { attachments: [], invalidTokens: 0 };

  const tokens = raw
    .split(/\s+|[,;](?=\s*https?:\/\/)/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const attachments: ParsedAttachment[] = [];
  let invalidTokens = 0;
  for (const token of tokens) {
    let parsed: URL;
    try {
      parsed = new URL(token);
    } catch {
      invalidTokens++;
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      invalidTokens++;
      continue;
    }
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop() ?? null;
    let fileName: string | null = null;
    if (lastSegment) {
      try {
        fileName = decodeURIComponent(lastSegment);
      } catch {
        fileName = lastSegment;
      }
    }
    const extMatch = fileName ? /\.([A-Za-z0-9]{1,8})$/.exec(fileName) : null;
    attachments.push({
      attachmentType: type,
      position: attachments.length + 1,
      url: token,
      host: parsed.hostname || null,
      fileName,
      extension: extMatch ? extMatch[1].toLowerCase() : null,
    });
  }
  return { attachments, invalidTokens };
}
