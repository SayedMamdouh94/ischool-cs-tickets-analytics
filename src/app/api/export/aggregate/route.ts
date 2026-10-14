import { type NextRequest } from "next/server";
import { checkViewer } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import {
  getBacklog,
  getDataQuality,
  getDurationHistogram,
  getFilterOptions,
  getGroupedMetrics,
  getPeriodComparison,
  getSettings,
  getVolumeSeries,
} from "@/lib/analytics/queries";
import { metricsTable, type MetricColumn } from "@/lib/analytics/tables";
import { parseFilters, resolveDateRange, toRpcFilters, type RpcFilters } from "@/lib/filters/schema";
import { DURATION_BUCKET_LABELS, keyLabel } from "@/lib/format";
import { toCsv, type TableData } from "@/lib/table-data";
import { callRpc } from "@/lib/supabase/rpc";
import type { Dimension } from "@/lib/analytics/types";

/**
 * Aggregated analytical data as CSV (no ticket-level content). Available to
 * analysts and administrators; respects the active filters; audited.
 */
const FULL: MetricColumn[] = [
  "tickets",
  "share",
  "completed",
  "pending",
  "rejected",
  "missing_status",
  "open_tickets",
  "completion_rate",
  "response_coverage",
  "response_n",
  "response_median_s",
  "response_p90_s",
  "resolution_coverage",
  "resolution_n",
  "resolution_median_s",
  "resolution_avg_s",
  "resolution_p90_s",
  "response_breach_rate",
  "resolution_breach_rate",
  "open_breaches",
  "unique_owners",
];

/** CSV gets raw seconds rather than formatted durations. */
function rawSeconds(t: TableData): TableData {
  return {
    columns: t.columns.map((c) => (c.kind === "duration" ? { ...c, label: `${c.label} (seconds)` } : c)),
    rows: t.rows,
  };
}

const grouped = (dim: Dimension, label: string) => async (f: RpcFilters) => rawSeconds(metricsTable((await getGroupedMetrics(f, dim, 1000)).rows, label, FULL, { labelFor: (r) => keyLabel(r.label) }));

const DATASETS: Record<string, (f: RpcFilters) => Promise<TableData>> = {
  projects: grouped("project", "Project"),
  programs: grouped("program", "Program"),
  topics: grouped("topic", "Topic"),
  themes: grouped("subcategory", "Issue theme"),
  lessons: grouped("lesson", "Lesson"),
  responders: grouped("responder", "Responder"),
  resolvers: grouped("resolver", "Resolver"),
  volume_daily: async (f) => {
    const s = await getVolumeSeries(f, "day", "project");
    return { columns: [{ key: "bucket", label: "Date (Africa/Cairo)" }, { key: "key", label: "Project" }, { key: "count", label: "Tickets", kind: "int" }], rows: s.points };
  },
  topics_period: async (f) => {
    const p = await getPeriodComparison(f, "topic", f.date_from ? null : 30);
    return {
      columns: [{ key: "key", label: "Topic" }, { key: "current", label: `Current ${p.current?.from}..${p.current?.to}`, kind: "int" }, { key: "previous", label: `Previous ${p.previous?.from}..${p.previous?.to}`, kind: "int" }],
      rows: p.rows,
    };
  },
  backlog: async (f) => {
    const b = await getBacklog(f, 1);
    return { columns: [{ key: "project", label: "Project" }, { key: "status", label: "Status" }, { key: "age_bucket", label: "Age at snapshot" }, { key: "count", label: "Tickets", kind: "int" }], rows: b.open };
  },
  resolution_distribution: async (f) => {
    const h = await getDurationHistogram(f, "resolution", "project");
    return {
      columns: [{ key: "band", label: "Resolution time" }, { key: "key", label: "Project" }, { key: "count", label: "Tickets", kind: "int" }],
      rows: h.bins.map((b) => ({ band: DURATION_BUCKET_LABELS[b.bucket], key: b.key, count: b.count })),
    };
  },
  data_quality: async (f) => {
    const d = await getDataQuality(f);
    return { columns: [{ key: "field", label: "Field" }, { key: "missing", label: "Missing", kind: "int" }], rows: d.missing_by_field };
  },
};

export async function GET(request: NextRequest) {
  const access = await checkViewer("analyst");
  if (!access.ok) return Response.json({ error: "Not authorized" }, { status: access.status });

  const params = request.nextUrl.searchParams;
  const dataset = params.get("dataset") ?? "";
  const build = DATASETS[dataset];
  if (!build) return Response.json({ error: "Unknown dataset" }, { status: 400 });

  const filters = parseFilters(params);
  const [options, settings] = await Promise.all([getFilterOptions(), getSettings()]);
  const range = resolveDateRange(filters, { datasetMax: options.date_range.max, anchor: settings.app.date_preset_anchor === "today" ? "today" : "dataset_end" });
  const rpcFilters = toRpcFilters(filters, range);
  const table = await build(rpcFilters);

  const supabase = await createClient();
  await callRpc(supabase, "record_export", {
    p_kind: `aggregate_${dataset}`,
    p_filters: rpcFilters,
    p_row_count: table.rows.length,
  });

  return new Response(toCsv(table), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${dataset}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
