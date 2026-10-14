import { mad, median } from "./stats";

export interface DailyPoint {
  date: string;
  count: number;
}

export interface Spike {
  date: string;
  count: number;
  baseline: number;
  /** Robust z-score: (count - baseline) / (1.4826 * MAD). */
  score: number;
}

/** Fills missing calendar days with zero so baselines are not biased upward. */
export function fillDailyGaps(points: DailyPoint[]): DailyPoint[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map(sorted.map((p) => [p.date, p.count]));
  const out: DailyPoint[] = [];
  const d = new Date(`${sorted[0].date}T00:00:00Z`);
  const end = new Date(`${sorted[sorted.length - 1].date}T00:00:00Z`);
  while (d <= end) {
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso, count: byDate.get(iso) ?? 0 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Flags days whose volume is unusually high relative to the trailing window,
 * using a robust baseline (rolling median + MAD) so a few big days do not
 * mask each other. Days are only evaluated once the trailing median reaches
 * `minBaseline`, so the start of an intake is not reported as a spike.
 * Flags describe *that* volume rose — never why.
 */
export function detectSpikes(
  series: DailyPoint[],
  opts: { window?: number; threshold?: number; minCount?: number; minHistory?: number; minBaseline?: number } = {},
): Spike[] {
  const window = opts.window ?? 28;
  const threshold = opts.threshold ?? 3.5;
  const minCount = opts.minCount ?? 10;
  const minHistory = opts.minHistory ?? 14;
  // Ignore ramp-up periods (e.g. an intake starting): a spike needs an established baseline.
  const minBaseline = opts.minBaseline ?? 5;
  const filled = fillDailyGaps(series);
  const spikes: Spike[] = [];

  for (let i = 0; i < filled.length; i++) {
    const history = filled.slice(Math.max(0, i - window), i).map((p) => p.count);
    if (history.length < minHistory) continue;
    const base = median(history) ?? 0;
    if (base < minBaseline) continue;
    const dev = mad(history) ?? 0;
    // Floor the spread so a flat history of identical values does not explode the score.
    const scale = Math.max(1.4826 * dev, Math.sqrt(Math.max(base, 1)));
    const score = (filled[i].count - base) / scale;
    if (filled[i].count >= minCount && score >= threshold) {
      spikes.push({ date: filled[i].date, count: filled[i].count, baseline: base, score: Math.round(score * 10) / 10 });
    }
  }
  return spikes;
}
