/**
 * Statistical helpers that mirror PostgreSQL semantics, used by the validator,
 * tests and the insight rules. `percentileCont` matches percentile_cont()
 * (linear interpolation between closest ranks).
 */

export function percentileCont(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p < 0 || p > 1) throw new RangeError("p must be between 0 and 1");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function median(values: number[]): number | null {
  return percentileCont(values, 0.5);
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function safeRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Relative change, or null when the base is zero. */
export function relativeChange(current: number, previous: number): number | null {
  return previous > 0 ? (current - previous) / previous : null;
}

/** Median absolute deviation (unscaled). */
export function mad(values: number[]): number | null {
  const m = median(values);
  if (m === null) return null;
  return median(values.map((v) => Math.abs(v - m)));
}
