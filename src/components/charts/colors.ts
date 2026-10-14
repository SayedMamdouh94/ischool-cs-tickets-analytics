/**
 * Color follows the entity, never its rank: each project keeps the same slot
 * everywhere, regardless of filters. Slots come from the validated palette in
 * globals.css (--series-1..8, light and dark variants).
 */
export const SERIES_COLORS = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);

const PROJECT_SLOTS: Record<string, number> = {
  DECI_4TH: 0,
  DECI_SUMMER: 1,
  DEMI_3RD: 2,
  DEMI_SUMMER: 3,
};

export function projectColor(code: string, fallbackIndex = 0): string {
  const slot = PROJECT_SLOTS[code];
  return SERIES_COLORS[slot ?? (4 + fallbackIndex) % SERIES_COLORS.length];
}

export const PROGRAM_COLORS: Record<string, string> = { DECI: SERIES_COLORS[0], DEMI: SERIES_COLORS[2] };
export const INTAKE_GROUP_COLORS: Record<string, string> = { Regular: SERIES_COLORS[0], Summer: SERIES_COLORS[1] };

/** Status colors are reserved for state and always shown with a text label. */
export const STATUS_COLORS: Record<string, string> = {
  completed: "var(--status-good)",
  pending: "var(--status-warning)",
  rejected: "var(--status-critical)",
  __none__: "var(--status-neutral)",
};

export const OTHER_COLOR = "var(--status-neutral)";
export const ACCENT = SERIES_COLORS[0];

export const SEQUENTIAL = ["var(--seq-100)", "var(--seq-200)", "var(--seq-300)", "var(--seq-400)", "var(--seq-500)", "var(--seq-600)", "var(--seq-700)"];
