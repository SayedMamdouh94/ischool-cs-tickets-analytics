import type { Grain, VolumeSeries } from "./types";

/**
 * Pure helpers that reshape SQL aggregates into chart-ready, serializable
 * structures. Series keys are made CSS-safe (s0, s1, …) because chart colors
 * are bound through CSS custom properties.
 */

export interface SeriesSpec {
  key: string;
  label: string;
  color: string;
  sourceKey: string;
}

function nextBucket(iso: string, grain: Grain): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (grain === "day") d.setUTCDate(d.getUTCDate() + 1);
  else if (grain === "week") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/** All buckets between the first and last point, so gaps render as zero. */
export function bucketRange(points: { bucket: string }[], grain: Grain): string[] {
  if (points.length === 0) return [];
  const sorted = [...new Set(points.map((p) => p.bucket))].sort();
  const out: string[] = [];
  let cur = sorted[0];
  const last = sorted[sorted.length - 1];
  let guard = 0;
  while (cur <= last && guard++ < 5000) {
    out.push(cur);
    cur = nextBucket(cur, grain);
  }
  return out;
}

/**
 * Pivot a long series (bucket, key, count) into wide rows, keeping the top N
 * keys by total and folding the remainder into "Other" (never a 9th hue).
 */
export function pivotSeries(
  series: VolumeSeries,
  opts: {
    colorFor: (sourceKey: string, index: number) => string;
    labelFor?: (sourceKey: string) => string;
    topN?: number;
    otherColor?: string;
    order?: string[];
  },
): { data: ({ bucket: string } & Record<string, number | string>)[]; series: SeriesSpec[] } {
  const totals = new Map<string, number>();
  for (const p of series.points) totals.set(p.key, (totals.get(p.key) ?? 0) + p.count);
  let keys = [...totals.keys()];
  if (opts.order) {
    keys.sort((a, b) => {
      const ia = opts.order!.indexOf(a);
      const ib = opts.order!.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || (totals.get(b)! - totals.get(a)!);
    });
  } else {
    keys.sort((a, b) => totals.get(b)! - totals.get(a)!);
  }
  const topN = opts.topN ?? 8;
  const kept = keys.slice(0, topN);
  const folded = keys.length > topN;
  keys = kept;

  const specs: SeriesSpec[] = keys.map((k, i) => ({
    key: `s${i}`,
    sourceKey: k,
    label: opts.labelFor?.(k) ?? k,
    color: opts.colorFor(k, i),
  }));
  if (folded) specs.push({ key: "other", sourceKey: "__other__", label: "Other", color: opts.otherColor ?? "var(--status-neutral)" });
  const keyFor = new Map(specs.map((s) => [s.sourceKey, s.key]));

  const buckets = bucketRange(series.points, series.grain);
  const rows = new Map<string, { bucket: string } & Record<string, number | string>>(
    buckets.map((b) => [b, { bucket: b, ...Object.fromEntries(specs.map((s) => [s.key, 0])) }]),
  );
  for (const p of series.points) {
    const row = rows.get(p.bucket);
    if (!row) continue;
    const k = keyFor.get(p.key) ?? (folded ? "other" : null);
    if (!k) continue;
    row[k] = (row[k] as number) + p.count;
  }
  return { data: [...rows.values()], series: specs };
}

/** Collapse a split series into a single total per bucket. */
export function totalsByBucket(series: VolumeSeries): { date: string; count: number }[] {
  const m = new Map<string, number>();
  for (const p of series.points) m.set(p.bucket, (m.get(p.bucket) ?? 0) + p.count);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
}
