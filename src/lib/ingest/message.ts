/**
 * Messages are produced by the ticketing form and often start with structured
 * fields, for example:
 *
 *   "Sub Topic: <text>\nDetails: <free text>"
 *   "Session ID: 5859718, Lesson: <name>, Start: <date>, End: <time>[, Details: <free text>]"
 *   "Info Type: <type>, Details: <free text>"
 *   "Details: <free text>"
 *
 * This parser extracts those fields where the structure supports it. It never
 * modifies the original message (which is stored verbatim).
 */

export type MessageStructure =
  | "session"
  | "sub_topic"
  | "info_type"
  | "details"
  | "logistics"
  | "placeholder"
  | "empty"
  | "unstructured";

export type MessageLanguage = "ar" | "en" | "mixed" | "none";

export interface ParsedMessage {
  structure: MessageStructure;
  subTopic: string | null;
  sessionRef: string | null;
  lessonName: string | null;
  sessionStartText: string | null;
  infoType: string | null;
  /** Free text written by the student, if any. */
  details: string | null;
  language: MessageLanguage;
}

const SESSION_RE =
  /^Session ID:\s*(\d+)(?:,\s*Lesson:\s*(.*?))?(?:,\s*Start:\s*(.*?))?(?:,\s*End:\s*(.*?))?(?:,\s*Details:\s*([\s\S]*))?$/;
const SUB_TOPIC_RE = /^Sub Topic:\s*([^\r\n]*)(?:\r?\n\s*Details:\s*([\s\S]*))?$/;
const INFO_TYPE_RE = /^Info Type:\s*(.*?)(?:,\s*Details:\s*([\s\S]*))?$/;
const DETAILS_RE = /^Details:\s*([\s\S]*)$/;
const LOGISTICS_RE = /^(?:Governorate|Area|Group|Slot):/;

function clean(value: string | undefined | null): string | null {
  if (value == null) return null;
  const v = value.trim();
  return v === "" ? null : v;
}

const ARABIC_LETTER = /[ء-يٮ-ۓۺ-ۿ]/gu;
const LATIN_LETTER = /[A-Za-z]/g;

export function detectLanguage(text: string | null | undefined): MessageLanguage {
  if (!text) return "none";
  const ar = text.match(ARABIC_LETTER)?.length ?? 0;
  const en = text.match(LATIN_LETTER)?.length ?? 0;
  const total = ar + en;
  if (total === 0) return "none";
  if (ar / total >= 0.7) return "ar";
  if (en / total >= 0.7) return "en";
  return "mixed";
}

export function parseMessage(message: string | null | undefined): ParsedMessage {
  const base: ParsedMessage = {
    structure: "empty",
    subTopic: null,
    sessionRef: null,
    lessonName: null,
    sessionStartText: null,
    infoType: null,
    details: null,
    language: "none",
  };
  if (message == null || message.trim() === "") return base;

  const text = message.trim();

  if (text === "-") {
    return { ...base, structure: "placeholder" };
  }

  let m = SESSION_RE.exec(text);
  if (m) {
    const details = clean(m[5]);
    return {
      ...base,
      structure: "session",
      sessionRef: m[1],
      lessonName: clean(m[2]),
      sessionStartText: clean(m[3]),
      details,
      language: detectLanguage(details),
    };
  }

  m = SUB_TOPIC_RE.exec(text);
  if (m) {
    const details = clean(m[2]);
    return {
      ...base,
      structure: "sub_topic",
      subTopic: clean(m[1]),
      details,
      language: detectLanguage(details),
    };
  }

  m = INFO_TYPE_RE.exec(text);
  if (m) {
    const details = clean(m[2]);
    return { ...base, structure: "info_type", infoType: clean(m[1]), details, language: detectLanguage(details) };
  }

  m = DETAILS_RE.exec(text);
  if (m) {
    const details = clean(m[1]);
    return { ...base, structure: "details", details, language: detectLanguage(details) };
  }

  if (LOGISTICS_RE.test(text)) {
    return { ...base, structure: "logistics" };
  }

  return { ...base, structure: "unstructured", details: text, language: detectLanguage(text) };
}

/**
 * Normalises the two known language variants of the form's "Sub Topic" values
 * so Arabic and English submissions are counted together.
 */
export function normalizeSubTopic(subTopic: string | null): string | null {
  if (!subTopic) return null;
  const s = subTopic.trim();
  if (
    s === "مشكلة أو استفسار متعلق بالجلسة الجارية الآن" ||
    (/related to the session currently in progress/i.test(s) && !/not related/i.test(s))
  ) {
    return "Related to the session in progress";
  }
  if (s === "مشكلة أو استفسار غير مرتبط بالجلسة الجارية الآن" || /not related to the session currently in progress/i.test(s)) {
    return "Not related to the session in progress";
  }
  return s;
}
