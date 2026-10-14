import type { SearchParamsRecord } from "@/lib/filters/schema";

/** Reads a single-valued page option, accepting only whitelisted values. */
export function pickParam<T extends string>(params: SearchParamsRecord, key: string, allowed: readonly T[], fallback: T): T {
  const raw = params[key];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return allowed.includes(v as T) ? (v as T) : fallback;
}

export function pickInt(params: SearchParamsRecord, key: string, fallback: number, min: number, max: number): number {
  const raw = params[key];
  const v = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

export function pickString(params: SearchParamsRecord, key: string, maxLength = 200): string | undefined {
  const raw = params[key];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return v && v.length <= maxLength ? v : undefined;
}
