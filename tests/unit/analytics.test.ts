import { describe, expect, it } from "vitest";
import { mad, mean, median, percentileCont, relativeChange } from "@/lib/analytics/stats";
import { detectProjectSpikes, detectSpikes, fillDailyGaps } from "@/lib/analytics/anomalies";
import { bucketRange, pivotSeries, totalsByBucket } from "@/lib/analytics/shape";
import { DEFAULT_RULES, buildInsights, describePeriods, rulesFrom, shareZ, type InsightInputs } from "@/lib/analytics/insights";
import type { GroupMetrics, PeriodComparison } from "@/lib/analytics/types";
import { csvEscape, toCsv } from "@/lib/table-data";
import { fmtDuration, fmtPct } from "@/lib/format";

describe("statistics (PostgreSQL percentile_cont semantics)", () => {
  it("interpolates percentiles linearly", () => {
    expect(percentileCont([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileCont([10], 0.9)).toBe(10);
    expect(percentileCont([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1);
    expect(percentileCont([], 0.5)).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(mean([1, 2, 3])).toBe(2);
    expect(mad([1, 1, 2, 2, 4, 6, 9])).toBe(1);
  });

  it("handles relative change without dividing by zero", () => {
    expect(relativeChange(15, 10)).toBe(0.5);
    expect(relativeChange(5, 0)).toBeNull();
  });
});

describe("durations and formatting", () => {
  it("formats durations by magnitude", () => {
    expect(fmtDuration(30)).toBe("<1 min");
    expect(fmtDuration(45 * 60)).toBe("45 min");
    expect(fmtDuration(6 * 3600)).toBe("6.0 h");
    expect(fmtDuration(10 * 86400)).toBe("10.0 d");
    expect(fmtDuration(null)).toBe("—");
    expect(fmtPct(0.995)).toBe("99.5%");
  });
});

describe("spike detection", () => {
  const days = (counts: number[]) => counts.map((count, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), count }));

  it("flags a clear spike against a stable baseline", () => {
    const series = days([...Array(30).fill(20), 90, 20, 21]);
    const spikes = detectSpikes(series);
    expect(spikes.map((s) => s.date)).toEqual(["2026-01-31"]);
    expect(spikes[0].baseline).toBe(20);
  });

  it("ignores ramp-up periods with no established baseline", () => {
    expect(detectSpikes(days([...Array(20).fill(0), 60, 80]))).toEqual([]);
  });

  it("fills missing days with zero", () => {
    expect(fillDailyGaps([{ date: "2026-01-01", count: 1 }, { date: "2026-01-03", count: 2 }])).toEqual([
      { date: "2026-01-01", count: 1 },
      { date: "2026-01-02", count: 0 },
      { date: "2026-01-03", count: 2 },
    ]);
  });
});

describe("series shaping", () => {
  it("fills weekly gaps and pivots with stable CSS-safe keys", () => {
    expect(bucketRange([{ bucket: "2026-01-05" }, { bucket: "2026-01-19" }], "week")).toEqual(["2026-01-05", "2026-01-12", "2026-01-19"]);
    const { data, series } = pivotSeries(
      { grain: "week", split: "project", points: [{ bucket: "2026-01-05", key: "B", count: 2 }, { bucket: "2026-01-19", key: "A", count: 5 }] },
      { colorFor: (k) => `c-${k}`, order: ["A", "B"] },
    );
    expect(series.map((s) => [s.key, s.sourceKey])).toEqual([["s0", "A"], ["s1", "B"]]);
    expect(data).toEqual([
      { bucket: "2026-01-05", s0: 0, s1: 2 },
      { bucket: "2026-01-12", s0: 0, s1: 0 },
      { bucket: "2026-01-19", s0: 5, s1: 0 },
    ]);
  });

  it("folds the tail into Other instead of generating extra colors", () => {
    const points = ["a", "b", "c"].map((k, i) => ({ bucket: "2026-01-01", key: k, count: 10 - i }));
    const { series, data } = pivotSeries({ grain: "day", split: "topic", points }, { colorFor: () => "x", topN: 2 });
    expect(series.map((s) => s.key)).toEqual(["s0", "s1", "other"]);
    expect(data[0].other).toBe(8);
    expect(totalsByBucket({ grain: "day", split: "topic", points })).toEqual([{ date: "2026-01-01", count: 27 }]);
  });
});

function metrics(over: Partial<GroupMetrics>): GroupMetrics {
  return {
    key: "k", label: "K", tickets: 0, completed: 0, pending: 0, rejected: 0, missing_status: 0, other_status: 0, closed_status: 0, unclassified_status: 0, open_tickets: 0,
    with_response_ts: 0, with_resolution_ts: 0, with_note: 0, generic_ack: 0, unique_owners: 0, response_n: 0, response_invalid: 0,
    response_avg_s: null, response_median_s: null, response_p90_s: null, response_breaches: 0, resolution_n: 0, resolution_invalid: 0,
    resolution_avg_s: null, resolution_median_s: null, resolution_p90_s: null, resolution_breaches: 0, open_breaches: 0,
    first_created_at: null, last_created_at: null, ...over,
  };
}

function periods(over: Partial<PeriodComparison> = {}): PeriodComparison {
  return {
    dimension: "topic",
    mode: "aligned",
    days: 30,
    current: { from: "2026-09-06", to: "2026-10-05", days: 30 },
    previous: { from: "2026-08-07", to: "2026-09-05", days: 30 },
    totals: { current: 600, previous: 600 },
    projects: [
      { project: "A", name: "Project A", included: true, reason: "ok", first_date: "2026-04-01", last_complete_date: "2026-10-05", current_from: "2026-09-06", current_to: "2026-10-05", previous_from: "2026-08-07", previous_to: "2026-09-05", current: 400, previous: 400 },
      { project: "B", name: "Project B", included: true, reason: "ok", first_date: "2026-05-01", last_complete_date: "2026-09-19", current_from: "2026-08-21", current_to: "2026-09-19", previous_from: "2026-07-22", previous_to: "2026-08-20", current: 200, previous: 200 },
      { project: "C", name: "Project C", included: false, reason: "insufficient_history", first_date: "2026-09-20", last_complete_date: "2026-10-05", current_from: null, current_to: null, previous_from: null, previous_to: null, current: 0, previous: 0 },
    ],
    rows: [
      { key: "Rising", label: null, current: 90, previous: 30 },
      { key: "Tiny", label: null, current: 6, previous: 1 },
      { key: "Flat", label: null, current: 100, previous: 100 },
    ],
    ...over,
  };
}

describe("deterministic insights", () => {
  const overall = metrics({ key: "all", tickets: 1000, completed: 990, open_tickets: 10, resolution_n: 990, resolution_median_s: 86400, resolution_breaches: 300, generic_ack: 990, with_response_ts: 900 });
  const base: InsightInputs = {
    overall,
    projects: [metrics({ key: "A", label: "Project A", tickets: 700, unique_owners: 350, open_tickets: 8, open_breaches: 3, resolution_n: 700, resolution_breaches: 250 }), metrics({ key: "B", label: "Project B", tickets: 300, unique_owners: 200, open_tickets: 2, resolution_n: 290, resolution_breaches: 50 })],
    topics: [metrics({ key: "Slow topic", tickets: 100, resolution_n: 100, resolution_median_s: 3 * 86400 }), metrics({ key: "Small slow topic", tickets: 5, resolution_n: 5, resolution_median_s: 9 * 86400 })],
    topicPeriods: periods(),
    topicThemes: {
      row_dimension: "topic",
      col_dimension: "subcategory",
      cells: [
        { row: "Big", col: "attendance_records", count: 80, resolution_median_s: null },
        { row: "Big", col: "other", count: 40, resolution_median_s: null },
        { row: "Alpha", col: "grades_evaluation", count: 60, resolution_median_s: null },
        { row: "Alpha", col: "other", count: 50, resolution_median_s: null },
        { row: "Zulu", col: "platform_access", count: 300, resolution_median_s: null },
        { row: "Zulu", col: "other", count: 100, resolution_median_s: null },
        { row: "Mid", col: "session_joining", count: 70, resolution_median_s: null },
        { row: "Mid", col: "other", count: 50, resolution_median_s: null },
      ],
    },
    recurring: null,
    spikes: [],
    subcategoryLabels: { attendance_records: "Attendance / absence records" },
    thresholds: { response_seconds: 86400, resolution_seconds: 3 * 86400 },
  };

  it("derives every statement from the inputs", () => {
    const ids = buildInsights(base).map((i) => i.id);
    expect(ids).toContain("volume-leader");
    expect(ids).toContain("topic-rising-Rising");
    expect(ids).not.toContain("topic-rising-Tiny"); // below the minimum count
    expect(ids).not.toContain("topic-rising-Flat");
    expect(ids).toContain("topic-slow-Slow topic");
    expect(ids).not.toContain("topic-slow-Small slow topic"); // n below the configured minimum
    expect(ids).toContain("outstanding-projects");
    expect(ids).toContain("response-caveat");
    const leader = buildInsights(base).find((i) => i.id === "volume-leader")!;
    expect(leader.statement).toContain("70.0%");
  });

  it("ranks recurring themes by tickets affected, not alphabetically", () => {
    const themes = buildInsights(base).filter((i) => i.id.startsWith("theme-")).map((i) => i.id);
    expect(themes).toEqual(["theme-Zulu-platform_access", "theme-Big-attendance_records", "theme-Mid-session_joining"]);
  });

  it("labels observations, recommendations and caveats explicitly", () => {
    const out = buildInsights(base);
    for (const i of out) expect(["observation", "recommendation", "caveat"]).toContain(i.kind);
    for (const i of out.filter((x) => x.kind === "recommendation")) expect(i.recommendation).toBeTruthy();
    expect(out.find((i) => i.id === "response-caveat")?.kind).toBe("caveat");
    expect(out.find((i) => i.id === "volume-leader")?.kind).toBe("observation");
  });

  it("compares topic shares, not raw counts, so growing activity is not a topic trend", () => {
    // Every topic doubles because the project doubled in size: no topic trend.
    const doubled = periods({ totals: { current: 1200, previous: 600 }, rows: [{ key: "Rising", label: null, current: 60, previous: 30 }, { key: "Flat", label: null, current: 200, previous: 100 }] });
    const ids = buildInsights({ ...base, topicPeriods: doubled }).map((i) => i.id);
    expect(ids.some((id) => id.startsWith("topic-rising"))).toBe(false);
    expect(shareZ(60, 1200, 30, 600)).toBe(0);
    expect(shareZ(90, 600, 30, 600)! > 1.96).toBe(true);
  });

  it("explains per-project comparison windows and exclusions", () => {
    const rising = buildInsights(base).find((i) => i.id === "topic-rising-Rising")!;
    expect(rising.method).toContain("own latest 30 complete days");
    expect(rising.method).toContain("Project B");
    expect(rising.method).toContain("started within the comparison period");
    expect(describePeriods(periods({ mode: "calendar" }))).toMatch(/^Selected period/);
  });

  it("reports when trends cannot be compared instead of inventing them", () => {
    const none = periods({ totals: { current: 0, previous: 0 }, rows: [], projects: periods().projects.map((p) => ({ ...p, included: false, reason: "insufficient_history" as const })) });
    const out = buildInsights({ ...base, topicPeriods: none });
    expect(out.find((i) => i.id === "trend-unavailable")?.kind).toBe("caveat");
    expect(out.some((i) => i.id.startsWith("topic-rising"))).toBe(false);
  });

  it("uses configurable thresholds", () => {
    const strict = rulesFrom([{ key: "trend_min_current", value: 500, min_value: 1, max_value: 10000, unit: "count", label: "", description: "", updated_at: "" }]);
    expect(strict.trend_min_current).toBe(500);
    expect(strict.slow_topic_factor).toBe(DEFAULT_RULES.slow_topic_factor);
    expect(buildInsights({ ...base, rules: strict }).some((i) => i.id === "topic-rising-Rising")).toBe(false);
    const lenient = { ...DEFAULT_RULES, slow_topic_min_n: 2 };
    expect(buildInsights({ ...base, rules: lenient }).some((i) => i.id === "topic-slow-Small slow topic")).toBe(true);
  });

  it("surfaces outdated exports, partial imports, unmapped topics and unclassified statuses", () => {
    const health = {
      coverage: [
        { project: "A", name: "Project A", status: "active" as const, tickets: 700, first_date: "2026-04-01", last_date: "2026-10-06", snapshot_at: "2026-10-06T12:00:00Z", last_complete_date: "2026-10-05" },
        { project: "B", name: "Project B", status: "active" as const, tickets: 300, first_date: "2026-05-01", last_date: "2026-09-20", snapshot_at: "2026-09-20T09:00:00Z", last_complete_date: "2026-09-19" },
        { project: "N", name: "New project", status: "active" as const, tickets: 0, first_date: null, last_date: null, snapshot_at: null, last_complete_date: null },
      ],
      activeImports: [{ project: "A", status: "importing", rows_applied: 500, rows_to_apply: 2000, started_at: "2026-10-20T08:00:00Z" }],
      partialImports: [{ project: "B", rows_applied: 1000, rows_to_apply: 3000 }],
      rejectedRows: [{ project: "A", rejected: 4, source_filename: "a.csv" }],
      unmappedTopics: 2,
      unclassifiedStatusTickets: 7,
    };
    const ids = buildInsights({ ...base, health }).map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["stale-exports", "import-running-A", "import-partial-B", "rejected-rows", "unmapped-topics", "unclassified-statuses", "empty-projects"]));
    const stale = buildInsights({ ...base, health }).find((i) => i.id === "stale-exports")!;
    expect(stale.statement).toContain("16 days earlier");
  });

  it("orders by severity, and an empty dataset yields only data caveats", () => {
    const out = buildInsights(base);
    const rank = { attention: 0, watch: 1, info: 2 } as const;
    expect(out.map((i) => rank[i.severity])).toEqual([...out.map((i) => rank[i.severity])].sort());
    expect(buildInsights({ ...base, overall: metrics({ tickets: 0 }) })).toEqual([]);
    const emptyHealth = { coverage: [{ project: "N", name: "New project", status: "active" as const, tickets: 0, first_date: null, last_date: null, snapshot_at: null, last_complete_date: null }], activeImports: [], partialImports: [], rejectedRows: [], unmappedTopics: 0, unclassifiedStatusTickets: 0 };
    expect(buildInsights({ ...base, overall: null, health: emptyHealth }).map((i) => i.id)).toEqual(["empty-projects"]);
  });
});

describe("per-project spike detection", () => {
  const days = (start: string, counts: number[]) =>
    counts.map((count, i) => {
      const d = new Date(`${start}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return { bucket: d.toISOString().slice(0, 10), count };
    });
  const opts = { window: 28, threshold: 3.5, minCount: 10, rampupDays: 21 };

  it("does not report an intake launch as an incident", () => {
    // Project B launches on day 40 with a burst; combined totals would look like a spike.
    const a = days("2026-06-01", Array.from({ length: 70 }, () => 20)).map((p) => ({ ...p, key: "A" }));
    const b = days("2026-07-10", [120, 90, 70, 60, 50, 40, ...Array.from({ length: 25 }, () => 30)]).map((p) => ({ ...p, key: "B" }));
    const combined = new Map<string, number>();
    for (const p of [...a, ...b]) combined.set(p.bucket, (combined.get(p.bucket) ?? 0) + p.count);
    expect(detectSpikes([...combined].map(([date, count]) => ({ date, count }))).length).toBeGreaterThan(0);
    const coverage = [
      { project: "A", first_date: "2026-06-01", last_complete_date: "2026-08-09" },
      { project: "B", first_date: "2026-07-10", last_complete_date: "2026-08-09" },
    ];
    expect(detectProjectSpikes([...a, ...b], coverage, opts)).toEqual([]);
  });

  it("still finds a genuine spike inside one project", () => {
    const counts = Array.from({ length: 60 }, () => 20);
    counts[45] = 140;
    const a = days("2026-06-01", counts).map((p) => ({ ...p, key: "A" }));
    const spikes = detectProjectSpikes(a, [{ project: "A", first_date: "2026-06-01", last_complete_date: "2026-07-30" }], opts);
    expect(spikes.map((s) => [s.project, s.date])).toEqual([["A", "2026-07-16"]]);
  });
});

describe("CSV export safety", () => {
  it("quotes and neutralizes spreadsheet formulas", () => {
    expect(csvEscape('a "quote", here')).toBe('"a ""quote"", here"');
    expect(csvEscape("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvEscape("-1+2")).toBe("'-1+2");
    expect(csvEscape(-5)).toBe("-5");
    expect(csvEscape(null)).toBe("");
  });

  it("writes a BOM so Arabic opens correctly in Excel", () => {
    const csv = toCsv({ columns: [{ key: "t", label: "Topic" }], rows: [{ t: "غياب" }] });
    expect(csv.startsWith("﻿Topic\r\n")).toBe(true);
    expect(csv).toContain("غياب");
  });
});
