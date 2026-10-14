import { describe, expect, it } from "vitest";
import { mad, mean, median, percentileCont, relativeChange } from "@/lib/analytics/stats";
import { detectSpikes, fillDailyGaps } from "@/lib/analytics/anomalies";
import { bucketRange, pivotSeries, totalsByBucket } from "@/lib/analytics/shape";
import { buildInsights, RULES } from "@/lib/analytics/insights";
import type { GroupMetrics } from "@/lib/analytics/types";
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
    key: "k", label: "K", tickets: 0, completed: 0, pending: 0, rejected: 0, missing_status: 0, other_status: 0, open_tickets: 0,
    with_response_ts: 0, with_resolution_ts: 0, with_note: 0, generic_ack: 0, unique_owners: 0, response_n: 0, response_invalid: 0,
    response_avg_s: null, response_median_s: null, response_p90_s: null, response_breaches: 0, resolution_n: 0, resolution_invalid: 0,
    resolution_avg_s: null, resolution_median_s: null, resolution_p90_s: null, resolution_breaches: 0, open_breaches: 0,
    first_created_at: null, last_created_at: null, ...over,
  };
}

describe("deterministic insights", () => {
  const overall = metrics({ key: "all", tickets: 1000, completed: 990, open_tickets: 10, resolution_n: 990, resolution_median_s: 86400, resolution_breaches: 300, generic_ack: 990, with_response_ts: 900 });
  const base = {
    overall,
    projects: [metrics({ key: "A", label: "Project A", tickets: 700, open_tickets: 8, open_breaches: 3, resolution_n: 700, resolution_breaches: 250 }), metrics({ key: "B", label: "Project B", tickets: 300, open_tickets: 2, resolution_n: 290, resolution_breaches: 50 })],
    topics: [metrics({ key: "Slow topic", tickets: 100, resolution_n: 100, resolution_median_s: 3 * 86400 }), metrics({ key: "Small slow topic", tickets: 5, resolution_n: 5, resolution_median_s: 9 * 86400 })],
    topicPeriods: {
      dimension: "topic",
      current: { from: "2026-09-01", to: "2026-09-30", days: 30 },
      previous: { from: "2026-08-02", to: "2026-08-31", days: 30 },
      rows: [
        { key: "Rising", label: null, current: 60, previous: 20 },
        { key: "Tiny", label: null, current: 5, previous: 1 },
      ],
    },
    topicThemes: { row_dimension: "topic" as const, col_dimension: "subcategory" as const, cells: [{ row: "Big", col: "attendance_records", count: 80, resolution_median_s: null }, { row: "Big", col: "other", count: 40, resolution_median_s: null }] },
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
    expect(ids).toContain("topic-slow-Slow topic");
    expect(ids).not.toContain("topic-slow-Small slow topic"); // n below RULES.slowTopicMinN
    expect(ids).toContain("theme-Big-attendance_records");
    expect(ids).toContain("outstanding-projects");
    expect(ids).toContain("response-caveat");
    const leader = buildInsights(base).find((i) => i.id === "volume-leader")!;
    expect(leader.statement).toContain("70.0%");
    expect(RULES.slowTopicMinN).toBeGreaterThan(5);
  });

  it("orders by severity and returns nothing for an empty selection", () => {
    const out = buildInsights(base);
    const rank = { attention: 0, watch: 1, info: 2 } as const;
    expect(out.map((i) => rank[i.severity])).toEqual([...out.map((i) => rank[i.severity])].sort());
    expect(buildInsights({ ...base, overall: metrics({ tickets: 0 }) })).toEqual([]);
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
