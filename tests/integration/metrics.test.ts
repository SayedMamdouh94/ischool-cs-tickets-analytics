import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { median, percentileCont } from "@/lib/analytics/stats";
import type { GroupedMetrics, TicketSearchResult, VolumeSeries } from "@/lib/analytics/types";
import { cairoDate, rpc, sourceFiles, stackReachable, userClient } from "./helpers";

const reachable = await stackReachable();

/**
 * SQL metric correctness: every figure below is recomputed independently in
 * TypeScript from the ORIGINAL CSV files and compared with the database
 * functions the dashboard uses.
 */
describe.skipIf(!reachable)("analytics functions vs. source files", () => {
  let client: SupabaseClient;
  const rows = () => sourceFiles().flatMap((f) => f.rows.map((r) => ({ ...r, project: f.project.code })));

  beforeAll(async () => {
    client = (await userClient("it-analyst@local.test", "analyst")).client;
  });

  it("totals, statuses and coverage match the files", async () => {
    const { data, error } = await rpc<GroupedMetrics>(client, "get_grouped_metrics", { p_filters: {}, p_dimension: "none" });
    expect(error).toBeNull();
    const o = data.rows[0];
    const all = rows();
    expect(o.tickets).toBe(all.length);
    expect(o.completed).toBe(all.filter((r) => r.record.status === "completed").length);
    expect(o.pending).toBe(all.filter((r) => r.record.status === "pending").length);
    expect(o.rejected).toBe(all.filter((r) => r.record.status === "rejected").length);
    expect(o.missing_status).toBe(all.filter((r) => r.record.status === null).length);
    expect(o.with_response_ts).toBe(all.filter((r) => r.respondedEpochMs !== null).length);
    expect(o.with_resolution_ts).toBe(all.filter((r) => r.resolvedEpochMs !== null).length);
    expect(o.unique_owners).toBe(new Set(all.map((r) => r.record.owner_id)).size);
  });

  it("duration statistics match independent computation (median, P90, averages)", async () => {
    const { data } = await rpc<GroupedMetrics>(client, "get_grouped_metrics", { p_filters: {}, p_dimension: "project" });
    for (const f of sourceFiles()) {
      const row = data.rows.find((r) => r.key === f.project.code)!;
      const res = f.rows.filter((r) => r.resolvedEpochMs !== null).map((r) => (r.resolvedEpochMs! - r.createdEpochMs) / 1000).filter((s) => s >= 0);
      const resp = f.rows.filter((r) => r.respondedEpochMs !== null).map((r) => (r.respondedEpochMs! - r.createdEpochMs) / 1000).filter((s) => s >= 0);
      expect(row.resolution_n).toBe(res.length);
      expect(row.resolution_median_s).toBe(Math.round(median(res)!));
      expect(row.resolution_p90_s).toBe(Math.round(percentileCont(res, 0.9)!));
      expect(row.resolution_avg_s).toBe(Math.round(res.reduce((a, b) => a + b, 0) / res.length));
      expect(row.response_n).toBe(resp.length);
      expect(row.response_median_s).toBe(Math.round(median(resp)!));
      // Threshold breaches with the default 72 h / 24 h thresholds.
      expect(row.resolution_breaches).toBe(res.filter((s) => s > 72 * 3600).length);
      expect(row.response_breaches).toBe(resp.filter((s) => s > 24 * 3600).length);
    }
  });

  it("filters (project, date range in Cairo time, status, topic) match the files", async () => {
    const filters = { projects: ["DEMI_3RD", "DECI_4TH"], date_from: "2026-07-01", date_to: "2026-08-31", statuses: ["completed"], topics: ["Report a Problem / inquiry"] };
    const { data } = await rpc<GroupedMetrics>(client, "get_grouped_metrics", { p_filters: filters, p_dimension: "none" });
    const expected = rows().filter((r) => {
      const d = cairoDate(r.createdEpochMs);
      return ["DEMI_3RD", "DECI_4TH"].includes(r.project) && d >= "2026-07-01" && d <= "2026-08-31" && r.record.status === "completed" && r.record.topic === "Report a Problem / inquiry";
    });
    expect(expected.length).toBeGreaterThan(100);
    expect(data.rows[0].tickets).toBe(expected.length);
  });

  it("the missing-status token and responder filter work", async () => {
    const none = await rpc<GroupedMetrics>(client, "get_grouped_metrics", { p_filters: { statuses: ["__none__"] }, p_dimension: "none" });
    expect(none.data.rows[0].tickets).toBe(1);
    const noResponder = await rpc<GroupedMetrics>(client, "get_grouped_metrics", { p_filters: { responders: ["__none__"] }, p_dimension: "none" });
    expect(noResponder.data.rows[0].tickets).toBe(rows().filter((r) => r.record.responder_name === null).length);
  });

  it("daily volume uses Africa/Cairo calendar days", async () => {
    const { data } = await rpc<VolumeSeries>(client, "get_volume_series", { p_filters: {}, p_grain: "day", p_split: "none" });
    const counts = new Map<string, number>();
    for (const r of rows()) counts.set(cairoDate(r.createdEpochMs), (counts.get(cairoDate(r.createdEpochMs)) ?? 0) + 1);
    expect(data.points).toHaveLength(counts.size);
    for (const p of data.points) expect(p.count).toBe(counts.get(p.bucket));
  });

  it("explorer search paginates and sorts on the server", async () => {
    const p1 = await rpc<TicketSearchResult>(client, "search_tickets", { p_filters: { projects: ["DECI_SUMMER"] }, p_sort: "ticket_id", p_dir: "asc", p_page: 1, p_page_size: 50 });
    const p2 = await rpc<TicketSearchResult>(client, "search_tickets", { p_filters: { projects: ["DECI_SUMMER"] }, p_sort: "ticket_id", p_dir: "asc", p_page: 2, p_page_size: 50 });
    expect(p1.data.total).toBe(582);
    expect(p1.data.rows).toHaveLength(50);
    const ids = [...p1.data.rows, ...p2.data.rows].map((r) => r.ticket_id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(100);
    // Use an owner ID from the local exports rather than hardcoding a student identifier.
    const owner = rows().find((r) => r.record.owner_id)!.record.owner_id!;
    const byOwner = await rpc<TicketSearchResult>(client, "search_tickets", { p_filters: {}, p_search: owner });
    expect(byOwner.data.total).toBeGreaterThan(0);
    expect(byOwner.data.rows.every((r) => r.owner_id === owner)).toBe(true);
    const capped = await rpc<TicketSearchResult>(client, "search_tickets", { p_filters: {}, p_page_size: 10_000 });
    expect(capped.data.rows.length).toBeLessThanOrEqual(100);
  });

  it("backlog counts unresolved tickets by current imported status", async () => {
    const { data } = await rpc<{ open: { count: number }[]; reconstructed: unknown[] }>(client, "get_backlog", { p_filters: {} });
    const open = data.open.reduce((a, x) => a + x.count, 0);
    expect(open).toBe(rows().filter((r) => r.resolvedEpochMs === null && (r.record.status === "pending" || r.record.status === null)).length);
    expect(data.reconstructed.length).toBeGreaterThan(100);
  });
});
