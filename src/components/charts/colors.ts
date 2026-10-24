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

/** Projects created later get a stable slot derived from their code (never from their position in a list). */
function hashedSlot(code: string): number {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
  return 4 + (h % 4);
}

export function projectColor(code: string): string {
  return SERIES_COLORS[PROJECT_SLOTS[code] ?? hashedSlot(code)];
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
