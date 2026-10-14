import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { PageActions } from "@/components/dashboard/page-actions";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { ChartCard } from "@/components/dashboard/chart-card";
import { EmptyState } from "@/components/dashboard/states";
import { TrendChart } from "@/components/charts/trend-chart";
import { BarListChart } from "@/components/charts/bar-list-chart";
import { STATUS_COLORS, projectColor } from "@/components/charts/colors";
import { requireViewer } from "@/lib/auth/dal";
import { getBacklog, getGroupedMetrics, getVolumeSeries, resolveFilterContext } from "@/lib/analytics/queries";
import { pivotSeries } from "@/lib/analytics/shape";
import { metricsTable } from "@/lib/analytics/tables";
import { hrefWithFilters, toRpcFilters, type SearchParamsRecord } from "@/lib/filters/schema";
import { AGE_BUCKET_LABELS, fmtDateTime, fmtDuration, fmtInt, fmtPct, keyLabel, ratio, statusLabel } from "@/lib/format";

export const metadata: Metadata = { title: "Project detail" };

export default function ProjectDetailPage({ params, searchParams }: PageProps<"/projects/[code]">) {
  return (
    <DashboardPage
      title="Project detail"
      description="Drill-down into one project. Other filters still apply."
      searchParams={searchParams}
      filterKeys={["date", "statuses", "topics", "responders", "resolvers"]}
      actions={<PageActions aggregate={[{ dataset: "topics", label: "Topic metrics" }]} />}
    >
      <ProjectDetail params={params} searchParams={searchParams} />
    </DashboardPage>
  );
}

async function ProjectDetail({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<SearchParamsRecord> }) {
  await requireViewer();
  const [{ code }, sp] = await Promise.all([params, searchParams]);
  const ctx = await resolveFilterContext(sp);
  const project = ctx.options.projects.find((p) => p.code === code);
  if (!project) notFound();

  const filters = { ...ctx.filters, projects: [code] };
  const rpc = toRpcFilters(filters, ctx.range);
  const [overallM, statusM, topicsM, respondersM, resolversM, daily, backlog] = await Promise.all([
    getGroupedMetrics(rpc, "none"),
    getGroupedMetrics(rpc, "status"),
    getGroupedMetrics(rpc, "topic"),
    getGroupedMetrics(rpc, "responder", 10),
    getGroupedMetrics(rpc, "resolver", 10),
    getVolumeSeries(rpc, "week", "none"),
    getBacklog(rpc, 10),
  ]);
  const o = overallM.rows[0];
  const color = projectColor(code);

  const trend = pivotSeries(daily, { colorFor: () => color, labelFor: () => "Tickets" });
  const openByBucket = Object.keys(AGE_BUCKET_LABELS).map((b) => ({
    label: AGE_BUCKET_LABELS[b],
    value: backlog.open.filter((x) => x.age_bucket === b).reduce((a, x) => a + x.count, 0),
  }));
  const snapshot = backlog.snapshots.find((s) => s.project === code)?.snapshot_at ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="size-3 rounded-full" style={{ background: color }} aria-hidden />
          <h2 className="text-lg font-semibold">{project.name}</h2>
          <span className="text-sm text-muted-foreground">
            {project.program} · {project.intake} · Organization {project.organization_id}
          </span>
        </div>
        <Link href={hrefWithFilters("/projects", ctx.filters)} className="inline-flex items-center gap-1 text-sm hover:underline">
          <ArrowLeft className="size-3.5" /> All projects
        </Link>
      </div>

      {!o || o.tickets === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <KpiCard label="Tickets" value={fmtInt(o.tickets)} info="Tickets for this project in the current filter selection." sub={`${fmtInt(o.unique_owners)} unique students`} />
            <KpiCard label="Completion rate" value={fmtPct(ratio(o.completed, o.tickets))} info="Completed ÷ all tickets." sub={`${fmtInt(o.completed)} completed`} />
            <KpiCard label="Unresolved" value={fmtInt(o.open_tickets)} info="Pending or missing status, with no resolution timestamp, in the latest export." sub={`${fmtInt(o.open_breaches)} over threshold`} />
            <KpiCard label="Median recorded response" value={fmtDuration(o.response_median_s)} info="Median of responded_at − created_at. A system timestamp — most response texts are templated acknowledgements." sub={`${fmtPct(ratio(o.with_response_ts, o.tickets))} have a timestamp`} />
            <KpiCard label="Median resolution" value={fmtDuration(o.resolution_median_s)} info="Median of resolved_at − created_at over tickets with a resolution timestamp." sub={`P90 ${fmtDuration(o.resolution_p90_s)}`} />
            <KpiCard label="Export snapshot" value={fmtDateTime(snapshot).split(",").slice(0, 2).join(",")} info="Latest timestamp in the most recent export for this project — used as 'now' when ageing unresolved tickets." sub="Africa/Cairo" />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <ChartCard
              className="xl:col-span-2"
              title="Weekly ticket volume"
              table={{ columns: [{ key: "bucket", label: "Week starting", kind: "date" }, { key: "s0", label: "Tickets", kind: "int" }], rows: trend.data }}
            >
              <TrendChart data={trend.data} series={trend.series} grain="week" variant="area" height={280} />
            </ChartCard>
            <ChartCard title="Status" table={metricsTable(statusM.rows, "Status", ["tickets", "share"], { labelFor: (r) => statusLabel(r.key === "__none__" ? null : r.key) })}>
              <BarListChart labelWidth={110} data={statusM.rows.map((r) => ({ label: statusLabel(r.key === "__none__" ? null : r.key), value: r.tickets, color: STATUS_COLORS[r.key] ?? STATUS_COLORS.__none__ }))} />
            </ChartCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Topics" description="Ticket count per topic." table={metricsTable(topicsM.rows, "Topic", ["tickets", "share", "pending", "resolution_median_s"])}>
              <BarListChart labelWidth={230} data={topicsM.rows.slice(0, 10).map((r) => ({ label: r.label, value: r.tickets, color: color, detail: `median resolution ${fmtDuration(r.resolution_median_s)}` }))} />
            </ChartCard>
            <ChartCard title="Unresolved tickets by age" description="Age measured at the export snapshot, not today." table={{ columns: [{ key: "label", label: "Age" }, { key: "value", label: "Tickets", kind: "int" }], rows: openByBucket }}>
              <BarListChart labelWidth={90} data={openByBucket.map((b) => ({ ...b, color: "var(--status-warning)" }))} />
            </ChartCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Top responders" description="Tickets with this name in Responder_Name (recorded first response)." table={metricsTable(respondersM.rows, "Responder", ["tickets", "response_median_s"], { labelFor: (r) => keyLabel(r.key) })}>
              <BarListChart labelWidth={170} data={respondersM.rows.map((r) => ({ label: keyLabel(r.key), value: r.tickets, color }))} />
            </ChartCard>
            <ChartCard title="Top resolvers" description="Tickets with this name in Resolved_By." table={metricsTable(resolversM.rows, "Resolver", ["tickets", "resolution_median_s"], { labelFor: (r) => keyLabel(r.key) })}>
              <BarListChart labelWidth={170} data={resolversM.rows.map((r) => ({ label: keyLabel(r.key), value: r.tickets, color }))} />
            </ChartCard>
          </div>

          <Link href={hrefWithFilters("/tickets", filters)} className="inline-flex items-center gap-1 self-start text-sm font-medium hover:underline">
            Browse this project&apos;s tickets <ArrowRight className="size-3.5" />
          </Link>
        </>
      )}
    </div>
  );
}
