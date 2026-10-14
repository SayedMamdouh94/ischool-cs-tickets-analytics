import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  filtersToSearchParams,
  hrefWithFilters,
  parseFilters,
  resolveDateRange,
  toRpcFilters,
} from "@/lib/filters/schema";
import { safeNext } from "@/lib/auth/redirect";

describe("URL filters", () => {
  it("round-trips through the query string", () => {
    const f = parseFilters(new URLSearchParams("project=DECI_4TH&project=DEMI_3RD&status=__none__&topic=Report a Problem / inquiry&preset=custom&from=2026-09-01&to=2026-09-30"));
    expect(f.projects).toEqual(["DECI_4TH", "DEMI_3RD"]);
    expect(f.statuses).toEqual(["__none__"]);
    expect(f.preset).toBe("custom");
    const again = parseFilters(filtersToSearchParams(f));
    expect(again).toEqual(f);
    expect(activeFilterCount(f)).toBe(4);
  });

  it("accepts the Next.js searchParams record shape", () => {
    expect(parseFilters({ project: "DECI_4TH", responder: ["a", "b"] })).toMatchObject({ projects: ["DECI_4TH"], responders: ["a", "b"] });
  });

  it("drops invalid values instead of failing", () => {
    const f = parseFilters(new URLSearchParams(`preset=bogus&from=2026-13-45&project=${"x".repeat(500)}&session=abc`));
    expect(f.preset).toBe("all");
    expect(f.from).toBeUndefined();
    expect(f.projects).toEqual([]);
    expect(f.session).toBeUndefined();
  });

  it("infers a custom range when only dates are given and keeps unrelated params", () => {
    const f = parseFilters(new URLSearchParams("from=2026-09-01"));
    expect(f.preset).toBe("custom");
    const qs = filtersToSearchParams(parseFilters(new URLSearchParams()), new URLSearchParams("grain=day&project=X"));
    expect(qs.toString()).toBe("grain=day");
    expect(hrefWithFilters("/tickets", f, { topics: ["T"] }, { ticket: "5" })).toBe("/tickets?topic=T&preset=custom&from=2026-09-01&ticket=5");
  });
});

describe("date presets", () => {
  const ctx = { datasetMax: "2026-10-06", anchor: "dataset_end" as const };

  it("anchors presets to the end of the dataset by default", () => {
    expect(resolveDateRange({ preset: "last_7" }, ctx)).toEqual({ from: "2026-09-30", to: "2026-10-06" });
    expect(resolveDateRange({ preset: "last_30" }, ctx)).toEqual({ from: "2026-09-07", to: "2026-10-06" });
    expect(resolveDateRange({ preset: "this_month" }, ctx)).toEqual({ from: "2026-10-01", to: "2026-10-06" });
    expect(resolveDateRange({ preset: "all" }, ctx)).toEqual({ from: null, to: null });
  });

  it("can anchor to today and normalizes reversed custom ranges", () => {
    expect(resolveDateRange({ preset: "last_7" }, { ...ctx, anchor: "today", today: "2026-10-14" })).toEqual({ from: "2026-10-08", to: "2026-10-14" });
    expect(resolveDateRange({ preset: "custom", from: "2026-09-30", to: "2026-09-01" }, ctx)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("produces the jsonb shape the SQL functions expect", () => {
    const f = parseFilters(new URLSearchParams("program=DEMI&lesson=Physical Session 1"));
    expect(toRpcFilters(f, { from: "2026-09-01", to: null })).toEqual({ programs: ["DEMI"], date_from: "2026-09-01", lesson: "Physical Session 1" });
  });
});

describe("post-login redirect", () => {
  it("only allows same-origin relative paths", () => {
    expect(safeNext("/tickets?q=1")).toBe("/tickets?q=1");
    expect(safeNext("https://evil.example")).toBe("/overview");
    expect(safeNext("//evil.example")).toBe("/overview");
    expect(safeNext("/\\evil.example")).toBe("/overview");
    expect(safeNext(undefined)).toBe("/overview");
  });
});
