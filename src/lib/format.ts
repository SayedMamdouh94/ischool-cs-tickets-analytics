import { NONE_TOKEN } from "@/lib/filters/schema";

export const TIME_ZONE = "Africa/Cairo";

const intFmt = new Intl.NumberFormat("en-US");
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function fmtInt(n: number | null | undefined): string {
  return n == null || Number.isNaN(n) ? "—" : intFmt.format(Math.round(n));
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return Math.abs(n) < 10_000 ? intFmt.format(Math.round(n)) : compactFmt.format(n);
}

export function fmtPct(ratio: number | null | undefined, digits = 1): string {
  if (ratio == null || Number.isNaN(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Human duration from seconds: "<1 min", "45 min", "6.2 h", "8.3 d". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const s = Math.abs(seconds);
  const sign = seconds < 0 ? "−" : "";
  if (s < 60) return `${sign}<1 min`;
  if (s < 3600) return `${sign}${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${sign}${(s / 3600).toFixed(1)} h`;
  return `${sign}${(s / 86400).toFixed(1)} d`;
}

export function hours(seconds: number | null | undefined): number | null {
  return seconds == null ? null : Math.round((seconds / 3600) * 10) / 10;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, year: "numeric", month: "short", day: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const shortDateFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const monthFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", year: "numeric" });
const calendarFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });

/** Instant (ISO timestamp) → Cairo calendar date. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return dateFmt.format(new Date(iso));
}

/** Instant (ISO timestamp) → Cairo date and time. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return dateTimeFmt.format(new Date(iso));
}

/** Calendar date ("YYYY-MM-DD", already in Cairo) → "Sep 1, 2026". */
export function fmtCalendarDate(day: string | null | undefined): string {
  if (!day) return "—";
  return calendarFmt.format(new Date(`${day}T00:00:00Z`));
}

/** Calendar date → short axis label for a grain. */
export function fmtBucket(day: string, grain: "day" | "week" | "month"): string {
  const d = new Date(`${day}T00:00:00Z`);
  return grain === "month" ? monthFmt.format(d) : shortDateFmt.format(d);
}

export const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  pending: "Pending",
  rejected: "Rejected",
  [NONE_TOKEN]: "Missing status",
};

export function statusLabel(status: string | null | undefined): string {
  if (status == null) return STATUS_LABELS[NONE_TOKEN];
  return STATUS_LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

/** Display label for a grouping key that may be the NULL token. */
export function keyLabel(key: string | null | undefined, fallback = "Not recorded"): string {
  if (key == null || key === NONE_TOKEN) return fallback;
  return key;
}

export const RESPONSE_KIND_LABELS: Record<string, string> = {
  generic_acknowledgement: "Generic acknowledgement",
  automated: "Automated processing message",
  custom: "Custom text",
  missing: "No response text",
};

export const AGE_BUCKET_LABELS: Record<string, string> = {
  lt_24h: "< 24 hours",
  "1_3d": "1–3 days",
  "3_7d": "3–7 days",
  gt_7d: "> 7 days",
};

export const DURATION_BUCKET_LABELS = ["< 1 h", "1–4 h", "4–24 h", "1–3 d", "3–7 d", "7–14 d", "14–30 d", "> 30 d"];

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
