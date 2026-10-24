import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { PageActions } from "@/components/dashboard/page-actions";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { ChartCard } from "@/components/dashboard/chart-card";
import { InsightCard } from "@/components/dashboard/insight-card";
import { EmptyState } from "@/components/dashboard/states";
import { SectionHeading } from "@/components/dashboard/page-header";
import { TrendChart } from "@/components/charts/trend-chart";
import { BarListChart } from "@/components/charts/bar-list-chart";
import { projectColor, STATUS_COLORS } from "@/components/charts/colors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireViewer } from "@/lib/auth/dal";
import {
  getGroupedMetrics,
  getImportRuns,
  getPeriodComparison,
  getVolumeSeries,
  resolveFilterContext,
} from "@/lib/analytics/queries";
import { loadInsights } from "@/lib/analytics/insights-loader";
import { pivotSeries } from "@/lib/analytics/shape";
import { metricsTable } from "@/lib/analytics/tables";
import { relativeChange } from "@/lib/analytics/stats";
import { hrefWithFilters, type SearchParamsRecord } from "@/lib/filters/schema";
import { fmtDate, fmtDateTime, fmtDuration, fmtInt, fmtPct, ratio, statusLabel } from "@/lib/format";

export const metadata: Metadata = { title: "Executive Overview" };

export default function OverviewPage({ searchParams }: PageProps<"/overview">) {
  return (
    <DashboardPage
      title="Executive Overview"
      description="Headline ticket volumes, statuses and handling times for the projects of the selected reporting cycle, computed from the imported exports."
      searchParams={searchParams}
      actions={<PageActions aggregate={[{ dataset: "projects", label: "Project metrics" }, { dataset: "topics", label: "Topic metrics" }]} />}
    >
      <OverviewContent searchParams={searchParams} />
    </DashboardPage>
  );
}

async function OverviewContent({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  await requireViewer();
  const ctx = await resolveFilterContext(await searchParams);
  const spanDays =
    ctx.range.from && ctx.range.to
      ? (Date.parse(ctx.range.to) - Date.parse(ctx.range.from)) / 86_400_000
      : null;
  const grain = spanDays !== null && spanDays <= 60 ? "day" : "week";

  const [overallM, projectsM, statusM, topicsM, series, period, runs, { insights }] = await Promise.all([
    getGroupedMetrics(ctx.rpc, "none"),
    getGroupedMetrics(ctx.rpc, "project"),
    getGroupedMetrics(ctx.rpc, "status"),
    getGroupedMetrics(ctx.rpc, "topic", 5),
    getVolumeSeries(ctx.rpc, grain, "project"),
    getPeriodComparison(ctx.rpc, "none", ctx.range.from ? null : 30),
    getImportRuns(20),
    loadInsights(ctx),
  ]);

  const o = overallM.rows[0];
  if (!o || o.tickets === 0) return <EmptyState />;

  const projectNames = Object.fromEntries(ctx.options.projects.map((p) => [p.code, p.name]));
  const trend = pivotSeries(series, {
    colorFor: (k) => projectColor(k),
    labelFor: (k) => projectNames[k] ?? k,
    order: ctx.options.projects.map((p) => p.code),
  });
  const p = period.rows[0];
  const periodDelta = p ? relativeChange(p.current, p.previous) : null;
  const latestRuns = runs.filter((r) => r.status.startsWith("completed"));
  const latestByProject = new Map<string, (typeof runs)[number]>();
  for (const r of latestRuns) if (r.project && !latestByProject.has(r.project)) latestByProject.set(r.project, r);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Total tickets"
          value={fmtInt(o.tickets)}
          info="Number of tickets in the current filter selection and reporting cycle, counted from the imported exports. The change compares each project's own latest 30 complete days with the 30 days before; projects without data for both periods are left out of the comparison."
          delta={
            period.current
              ? {
                  value: periodDelta,
                  label: `vs prior ${period.days} d`,
                  goodDirection: "neutral",
                }
              : undefined
          }
          sub={<span>{fmtInt(o.unique_owners)} unique students</span>}
        />
        <KpiCard
          label="Completed"
          value={fmtInt(o.completed)}
          info="Tickets whose Status in the latest export is 'completed'. A completed status does not guarantee a resolution timestamp exists."
          sub={<span>{fmtInt(o.rejected)} rejected</span>}
        />
        <KpiCard
          label="Pending"
          value={fmtInt(o.pending)}
          info="Tickets whose Status in the latest export is 'pending'. Statuses reflect the export snapshot, not live data."
          sub={<span>{fmtInt(o.missing_status)} with missing status</span>}
        />
        <KpiCard
          label="Completion rate"
          value={fmtPct(ratio(o.completed, o.tickets))}
          info="Completed tickets ÷ all tickets in view. Missing statuses count in the denominator and are not treated as pending."
          sub={<span>{fmtInt(o.open_tickets)} unresolved (open statuses, no resolution time)</span>}
        />
        <KpiCard
          label="Median resolution"
          value={fmtDuration(o.resolution_median_s)}
          info="Median of (resolved_at − created_at) over tickets with a valid resolution timestamp. Tickets without one are excluded and reported separately."
          sub={
            <span>
              P90 {fmtDuration(o.resolution_p90_s)} · n={fmtInt(o.resolution_n)}
            </span>
          }
        />
        <KpiCard
          label="Response recorded"
          value={fmtPct(ratio(o.with_response_ts, o.tickets))}
          info="Share of tickets with a Responded_At timestamp. Most response texts are templated acknowledgements, so this is a system timestamp — not proof of a human reply."
          sub={<span>Median recorded response {fmtDuration(o.response_median_s)}</span>}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard
          className="xl:col-span-2"
          title={`Ticket volume by ${grain === "day" ? "day" : "week"}`}
          description={`New tickets by creation date (Africa/Cairo), split by project.${grain === "week" ? " Weeks start on Monday." : ""}`}
          table={{
            columns: [{ key: "bucket", label: grain === "day" ? "Date" : "Week starting", kind: "date" }, ...trend.series.map((s) => ({ key: s.key, label: s.label, kind: "int" as const }))],
            rows: trend.data,
          }}
          exportName="ticket-volume"
        >
          <TrendChart data={trend.data} series={trend.series} grain={grain} height={300} />
        </ChartCard>
        <ChartCard
          title="Tickets by project"
          description="Share of tickets in the current view."
          table={metricsTable(projectsM.rows, "Project", ["tickets", "share", "completion_rate"])}
          footer={
            <Link href={hrefWithFilters("/projects", ctx.filters)} className="inline-flex items-center gap-1 font-medium text-foreground hover:underline">
              Compare projects <ArrowRight className="size-3" />
            </Link>
          }
        >
          <BarListChart
            labelWidth={140}
            data={projectsM.rows.map((r) => ({
              label: r.label,
              value: r.tickets,
              color: projectColor(r.key),
              detail: `${fmtPct(ratio(r.tickets, o.tickets))} of tickets`,
            }))}
          />
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Status breakdown"
          description="Status as recorded in the latest export of each project."
          table={metricsTable(statusM.rows, "Status", ["tickets", "share"], { labelFor: (r) => statusLabel(r.key === "__none__" ? null : r.key) })}
        >
          <BarListChart
            labelWidth={120}
            data={statusM.rows.map((r) => ({
              label: statusLabel(r.key === "__none__" ? null : r.key),
              value: r.tickets,
              color: STATUS_COLORS[r.key] ?? STATUS_COLORS.__none__,
              detail: fmtPct(ratio(r.tickets, o.tickets), 2),
            }))}
          />
        </ChartCard>
        <ChartCard
          title="Top five topics"
          description="Most frequent ticket topics as selected by students (not a verified root cause)."
          table={metricsTable(topicsM.rows, "Topic", ["tickets", "share", "pending", "resolution_median_s"], { total: o.tickets })}
          footer={
            <Link href={hrefWithFilters("/topics", ctx.filters)} className="inline-flex items-center gap-1 font-medium text-foreground hover:underline">
              All topics and complaints <ArrowRight className="size-3" />
            </Link>
          }
        >
          <BarListChart
            labelWidth={230}
            data={topicsM.rows.map((r) => ({ label: r.label, value: r.tickets, detail: `${fmtPct(ratio(r.tickets, o.tickets))} of tickets · median resolution ${fmtDuration(r.resolution_median_s)}` }))}
          />
        </ChartCard>
      </div>

      <section className="flex flex-col gap-3">
        <SectionHeading
          title="Key operational observations"
          description="Generated by deterministic rules from the figures above. Each links to the evidence."
          actions={
            <Link href={hrefWithFilters("/insights", ctx.filters)} className="inline-flex items-center gap-1 text-sm font-medium hover:underline">
              All insights <ArrowRight className="size-3.5" />
            </Link>
          }
        />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {insights.slice(0, 4).map((i) => (
            <InsightCard key={i.id} insight={i} filters={ctx.filters} compact />
          ))}
        </div>
      </section>

      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Latest imports</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {ctx.options.projects.map((proj) => {
            const run = latestByProject.get(proj.code);
            return (
              <div key={proj.code} className="rounded-lg border p-3 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <span className="size-2.5 rounded-full" style={{ background: projectColor(proj.code) }} aria-hidden />
                  {proj.name}
                </div>
                {run ? (
                  <dl className="mt-2 grid gap-0.5 text-xs text-muted-foreground">
                    <div>Data as of {fmtDateTime(run.data_as_of)}</div>
                    <div>Imported {fmtDate(run.completed_at)} · {fmtInt(run.records_in_file)} rows</div>
                  </dl>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">No completed import yet.</p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
