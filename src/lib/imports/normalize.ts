import { cairoOffsetMinutes } from "@/lib/ingest/timestamps";

const CANONICAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/;
const ISO_LIKE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

export type TimestampNote = "converted" | "assumed_cairo";

function pad(n: number, width = 2): string {
  return String(Math.abs(n)).padStart(width, "0");
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const m = Math.abs(minutes);
  return `${sign}${pad(Math.floor(m / 60))}${pad(m % 60)}`;
}

/** UTC offset of Africa/Cairo for a local wall-clock time (DST-aware). */
export function cairoOffsetForWallTime(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = cairoOffsetMinutes(wallAsUtc - 2 * 3600_000);
  return cairoOffsetMinutes(wallAsUtc - first * 60_000);
}

/**
 * Brings a timestamp written in a common alternative form to the export format
 * `YYYY-MM-DD HH:MM:SS ±HHMM`. Values already in that format are returned
 * byte-for-byte (so row hashes of original exports never change). Values the
 * function does not recognise are returned unchanged for the validator to reject.
 *
 *   2026-09-01T10:15:00+03:00 → 2026-09-01 10:15:00 +0300   (converted)
 *   2026-09-01 10:15          → 2026-09-01 10:15:00 +0300   (assumed_cairo)
 */
export function normalizeTimestampText(raw: string): { value: string; note?: TimestampNote } {
  const v = raw.trim();
  if (v === "" || CANONICAL.test(v)) return { value: raw };
  const m = ISO_LIKE.exec(v);
  if (!m) return { value: raw };
  const [, y, mo, d, h, mi, s = "00", off] = m;
  if (!off) {
    const offset = cairoOffsetForWallTime(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s));
    return { value: `${y}-${mo}-${d} ${h}:${mi}:${s} ${formatOffset(offset)}`, note: "assumed_cairo" };
  }
  const offset = off.toUpperCase() === "Z" ? "+0000" : off.replace(":", "");
  return { value: `${y}-${mo}-${d} ${h}:${mi}:${s} ${offset}`, note: "converted" };
}

/** Excel stores date-times without a time zone; ExcelJS returns them as UTC-based Dates. */
export function excelDateToWallClock(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}
