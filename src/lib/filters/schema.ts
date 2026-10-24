import { z } from "zod";

/**
 * Global dashboard filters. They live in the URL query string so every view
 * is shareable and every chart, KPI, table and export reads the same slice.
 *
 *   ?project=DECI_4TH&project=DEMI_3RD&preset=last_30&status=pending
 */

export const DATE_PRESETS = ["all", "last_7", "last_30", "last_90", "this_month", "custom"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  all: "All available data",
  last_7: "Last 7 days",
  last_30: "Last 30 days",
  last_90: "Last 90 days",
  this_month: "This month",
  custom: "Custom range",
};

/** URL parameter name → filter field. */
export const LIST_FILTERS = {
  project: "projects",
  program: "programs",
  intake: "intakes",
  status: "statuses",
  topic: "topics",
  responder: "responders",
  resolver: "resolvers",
  category: "categories",
  theme: "subcategories",
} as const;

export type ListParam = keyof typeof LIST_FILTERS;
export type ListField = (typeof LIST_FILTERS)[ListParam];

/** Matches NULL values for status / responder / resolver. */
export const NONE_TOKEN = "__none__";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)));
const listValue = z.string().trim().min(1).max(200);

export const filtersSchema = z.object({
  projects: z.array(listValue).max(50).default([]),
  programs: z.array(listValue).max(50).default([]),
  intakes: z.array(listValue).max(50).default([]),
  statuses: z.array(listValue).max(50).default([]),
  topics: z.array(listValue).max(50).default([]),
  responders: z.array(listValue).max(100).default([]),
  resolvers: z.array(listValue).max(100).default([]),
  categories: z.array(listValue).max(50).default([]),
  subcategories: z.array(listValue).max(50).default([]),
  preset: z.enum(DATE_PRESETS).default("all"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  session: z.string().regex(/^\d{1,18}$/).optional(),
  lesson: z.string().trim().min(1).max(300).optional(),
  /** Reporting cycle code; absent = the current cycle. Analytics never combine cycles. */
  cycle: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/).optional(),
  /** Include archived projects of the selected cycle (explicit historical view). */
  archived: z.boolean().default(false),
});

export type DashboardFilters = z.output<typeof filtersSchema>;

export type SearchParamsRecord = Record<string, string | string[] | undefined>;

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).filter((s) => s.trim() !== "");
}

function asSingle(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() !== "" ? s.trim() : undefined;
}

/**
 * Parses untrusted URL parameters. Invalid entries are dropped rather than
 * failing the page, so a hand-edited URL degrades gracefully.
 */
export function parseFilters(params: SearchParamsRecord | URLSearchParams): DashboardFilters {
  const get = (key: string): string | string[] | undefined => {
    if (params instanceof URLSearchParams) {
      const all = params.getAll(key);
      return all.length === 0 ? undefined : all.length === 1 ? all[0] : all;
    }
    return params[key];
  };

  const raw: Record<string, unknown> = {};
  for (const [param, field] of Object.entries(LIST_FILTERS)) {
    raw[field] = [...new Set(asArray(get(param)))].filter((v) => listValue.safeParse(v).success);
  }
  const preset = asSingle(get("preset"));
  raw.preset = DATE_PRESETS.includes(preset as DatePreset) ? preset : undefined;
  const from = asSingle(get("from"));
  const to = asSingle(get("to"));
  if (from && isoDate.safeParse(from).success) raw.from = from;
  if (to && isoDate.safeParse(to).success) raw.to = to;
  if (raw.preset === undefined && (raw.from || raw.to)) raw.preset = "custom";
  const session = asSingle(get("session"));
  if (session && /^\d{1,18}$/.test(session)) raw.session = session;
  const lesson = asSingle(get("lesson"));
  if (lesson && lesson.length <= 300) raw.lesson = lesson;
  const cycle = asSingle(get("cycle"));
  if (cycle && /^[A-Z][A-Z0-9_]{1,39}$/.test(cycle)) raw.cycle = cycle;
  raw.archived = asSingle(get("archived")) === "1";

  const parsed = filtersSchema.safeParse(raw);
  return parsed.success ? parsed.data : filtersSchema.parse({});
}

/** Serializes filters back to URL parameters (omitting defaults). */
export function filtersToSearchParams(f: DashboardFilters, base?: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(base);
  for (const param of [...Object.keys(LIST_FILTERS), "preset", "from", "to", "session", "lesson", "cycle", "archived"]) {
    out.delete(param);
  }
  for (const [param, field] of Object.entries(LIST_FILTERS) as [ListParam, ListField][]) {
    for (const v of f[field]) out.append(param, v);
  }
  if (f.preset !== "all") out.set("preset", f.preset);
  if (f.preset === "custom") {
    if (f.from) out.set("from", f.from);
    if (f.to) out.set("to", f.to);
  }
  if (f.session) out.set("session", f.session);
  if (f.lesson) out.set("lesson", f.lesson);
  if (f.cycle) out.set("cycle", f.cycle);
  if (f.archived) out.set("archived", "1");
  return out;
}

export function activeFilterCount(f: DashboardFilters): number {
  let n = Object.values(LIST_FILTERS).reduce((acc, field) => acc + (f[field].length > 0 ? 1 : 0), 0);
  if (f.preset !== "all") n++;
  if (f.session) n++;
  if (f.lesson) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

export interface DateRange {
  from: string | null;
  to: string | null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date in Africa/Cairo. */
export function cairoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Resolves a preset into concrete Cairo calendar dates. Because the data is a
 * historical export, presets are anchored by default to the LAST DATE IN THE
 * DATASET ("dataset_end"), not to today — "Last 30 days" means the last 30 days
 * of available data. The anchor is configurable in Settings and always shown.
 */
export function resolveDateRange(
  f: Pick<DashboardFilters, "preset" | "from" | "to">,
  ctx: { datasetMax: string | null; anchor: "dataset_end" | "today"; today?: string },
): DateRange {
  const anchor = ctx.anchor === "today" ? (ctx.today ?? cairoToday()) : ctx.datasetMax;
  switch (f.preset) {
    case "all":
      return { from: null, to: null };
    case "custom": {
      let from = f.from ?? null;
      let to = f.to ?? null;
      if (from && to && from > to) [from, to] = [to, from];
      return { from, to };
    }
    case "last_7":
    case "last_30":
    case "last_90": {
      if (!anchor) return { from: null, to: null };
      const days = f.preset === "last_7" ? 7 : f.preset === "last_30" ? 30 : 90;
      return { from: addDays(anchor, -(days - 1)), to: anchor };
    }
    case "this_month": {
      if (!anchor) return { from: null, to: null };
      return { from: `${anchor.slice(0, 8)}01`, to: anchor };
    }
  }
}

/** The jsonb object understood by every analytics SQL function. */
export type RpcFilters = Partial<Record<ListField, string[]>> & {
  date_from?: string;
  date_to?: string;
  session_ref?: string;
  lesson?: string;
  cycle?: string;
  include_archived?: boolean;
};

/** The scope part of the filters (also sent on its own to get_filter_options). */
export interface RpcScope {
  cycle?: string;
  include_archived?: boolean;
}

export function toRpcScope(f: Pick<DashboardFilters, "cycle" | "archived">): RpcScope {
  const out: RpcScope = {};
  if (f.cycle) out.cycle = f.cycle;
  if (f.archived) out.include_archived = true;
  return out;
}

export function toRpcFilters(f: DashboardFilters, range: DateRange): RpcFilters {
  const out: RpcFilters = {};
  for (const field of Object.values(LIST_FILTERS)) {
    if (f[field].length > 0) out[field] = f[field];
  }
  if (range.from) out.date_from = range.from;
  if (range.to) out.date_to = range.to;
  if (f.session) out.session_ref = f.session;
  if (f.lesson) out.lesson = f.lesson;
  return { ...out, ...toRpcScope(f) };
}

/** Builds a dashboard link that carries the current filters plus overrides. */
export function hrefWithFilters(
  pathname: string,
  f: DashboardFilters,
  overrides: Partial<DashboardFilters> = {},
  extra: Record<string, string> = {},
): string {
  const params = filtersToSearchParams({ ...f, ...overrides });
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
