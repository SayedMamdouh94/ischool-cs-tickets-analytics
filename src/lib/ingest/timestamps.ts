/**
 * Source timestamps look like `2026-09-01 00:08:39 +0300`. They carry an
 * explicit UTC offset (+0200 or +0300 for Egypt standard/summer time), so the
 * absolute instant is unambiguous and is stored as TIMESTAMPTZ.
 */
const SOURCE_TS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

export const DISPLAY_TIME_ZONE = "Africa/Cairo";

export interface ParsedTimestamp {
  /** ISO-8601 string preserving the source offset, e.g. 2026-09-01T00:08:39+03:00 */
  iso: string;
  epochMs: number;
  /** Offset as written in the source, in minutes east of UTC. */
  offsetMinutes: number;
  /** Raw offset token, e.g. "+0300". */
  offsetToken: string;
}

export class TimestampError extends Error {}

export function parseSourceTimestamp(raw: string): ParsedTimestamp {
  const value = raw.trim();
  const m = SOURCE_TS.exec(value);
  if (!m) {
    throw new TimestampError(`Unrecognised timestamp format: "${value.slice(0, 40)}"`);
  }
  const [, y, mo, d, h, mi, s, sign, oh, om] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const offH = Number(oh);
  const offM = Number(om);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new TimestampError(`Timestamp component out of range: "${value}"`);
  }
  if (offH > 14 || offM > 59) {
    throw new TimestampError(`Invalid UTC offset: "${value}"`);
  }

  // Validate the calendar date (rejects e.g. 2026-02-30).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new TimestampError(`Invalid calendar date: "${value}"`);
  }

  const offsetMinutes = (sign === "-" ? -1 : 1) * (offH * 60 + offM);
  const epochMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${oh}:${om}`;

  return { iso, epochMs, offsetMinutes, offsetToken: `${sign}${oh}${om}` };
}

/** Optional variant: blank → null, otherwise strict parse. */
export function parseOptionalTimestamp(raw: string | undefined | null): ParsedTimestamp | null {
  if (raw == null || raw.trim() === "") return null;
  return parseSourceTimestamp(raw);
}

const offsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  timeZoneName: "longOffset",
});

/** UTC offset (minutes) of Africa/Cairo at a given instant, from the runtime tz database. */
export function cairoOffsetMinutes(epochMs: number): number {
  const part = offsetFormatter.formatToParts(new Date(epochMs)).find((p) => p.type === "timeZoneName");
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part?.value ?? "");
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** True when the offset written in the source matches Cairo local time at that instant. */
export function offsetMatchesCairo(ts: ParsedTimestamp): boolean {
  return cairoOffsetMinutes(ts.epochMs) === ts.offsetMinutes;
}
