import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { PageActions } from "@/components/dashboard/page-actions";
import { ChartCard } from "@/components/dashboard/chart-card";
import { SectionHeading } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/states";
import { ComparisonTable } from "@/components/dashboard/comparison-table";
import { SegmentedParam } from "@/components/filters/segmented-param";
import { TrendChart } from "@/components/charts/trend-chart";
import { BarListChart } from "@/components/charts/bar-list-chart";
import { ColumnChart } from "@/components/charts/column-chart";
import { INTAKE_GROUP_COLORS, PROGRAM_COLORS, SERIES_COLORS, projectColor } from "@/components/charts/colors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireViewer } from "@/lib/auth/dal";
import { getCrossTab, getGroupedMetrics, getVolumeSeries, resolveFilterContext } from "@/lib/analytics/queries";
import { pivotSeries } from "@/lib/analytics/shape";
import { metricsTable } from "@/lib/analytics/tables";
import type { Dimension, GroupMetrics } from "@/lib/analytics/types";
import { hrefWithFilters, type SearchParamsRecord } from "@/lib/filters/schema";
import { fmtDuration, fmtInt, fmtPct, hours, ratio } from "@/lib/format";
import { pickParam } from "@/lib/search-params";

export const metadata: Metadata = { title: "Projects" };

const COMPARE_BY = ["project", "program", "intake_group"] as const;
type CompareBy = (typeof COMPARE_BY)[number];
const COMPARE_LABEL: Record<CompareBy, string> = { project: "Project", program: "Program", intake_group: "Intake group" };

export default function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  return (
    <DashboardPage
      title="Projects Comparison"
      description="The four projects side by side, or grouped by program (DECI vs DEMI) and intake group (regular vs summer)."
      searchParams={searchParams}
      actions={<PageActions aggregate={[{ dataset: "projects", label: "Project metrics" }, { dataset: "programs", label: "Program metrics" }]} />}
    >
      <ProjectsContent searchParams={searchParams} />
    </DashboardPage>
  );
}

function colorFor(by: CompareBy, key: string, i: number): string {
  if (by === "project") return projectColor(key, i);
  if (by === "program") return PROGRAM_COLORS[key] ?? SERIES_COLORS[i % 8];
  return INTAKE_GROUP_COLORS[key] ?? SERIES_COLORS[i % 8];
}

async function ProjectsContent({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  await requireViewer();
  const sp = await searchParams;
  const ctx = await resolveFilterContext(sp);
  const by = pickParam(sp, "by", COMPARE_BY, "project");
  const dim: Dimension = by;

  const [metrics, overall, series, topicTab] = await Promise.all([
    getGroupedMetrics(ctx.rpc, dim),
    getGroupedMetrics(ctx.rpc, "none"),
    getVolumeSeries(ctx.rpc, "week", by === "project" ? "project" : by === "program" ? "program" : "intake_group"),
    getCrossTab(ctx.rpc, "topic", dim),
  ]);
  const total = overall.rows[0]?.tickets ?? 0;
  if (total === 0) return <EmptyState />;

  const order = by === "project" ? ctx.options.projects.map((p) => p.code) : undefined;
  const rows = [...metrics.rows].sort((a, b) => (order ? order.indexOf(a.key) - order.indexOf(b.key) : b.tickets - a.tickets));
  const labelOf = (r: GroupMetrics) => r.label;
  const trend = pivotSeries(series, {
    colorFor: (k, i) => colorFor(by, k, i),
    labelFor: (k) => rows.find((r) => r.key === k)?.label ?? k,
    order: rows.map((r) => r.key),
  });

  const table = metricsTable(rows, COMPARE_LABEL[by], [
    "tickets",
    "share",
    "completed",
    "pending",
    "completion_rate",
    "response_coverage",
    "response_median_s",
    "resolution_median_s",
    "resolution_p90_s",
    "resolution_breach_rate",
    "open_tickets",
    "unique_owners",
  ]);

  // Top issues per group from the topic × group cross tab.
  const topIssues = rows.map((r) => {
    const cells = topicTab.cells.filter((c) => c.col === r.key).sort((a, b) => b.count - a.count);
    return { group: r, top: cells.slice(0, 4) };
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedParam
          param="by"
          label="Compare by"
          defaultValue="project"
          options={COMPARE_BY.map((v) => ({ value: v, label: COMPARE_LABEL[v] }))}
        />
        <p className="text-xs text-muted-foreground">Sort the table by any column. Click a project to drill down.</p>
      </div>

      <ComparisonTable table={table} linkBase={by === "project" ? "/projects" : undefined} filters={ctx.filters} colorKeys={Object.fromEntries(rows.map((r, i) => [r.key, colorFor(by, r.key, i)]))} />

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard
          className="xl:col-span-2"
          title="Weekly ticket volume"
          description={`New tickets per week, by ${COMPARE_LABEL[by].toLowerCase()}. Weeks start on Monday (Africa/Cairo).`}
          table={{ columns: [{ key: "bucket", label: "Week starting", kind: "date" }, ...trend.series.map((s) => ({ key: s.key, label: s.label, kind: "int" as const }))], rows: trend.data }}
        >
          <TrendChart data={trend.data} series={trend.series} grain="week" height={300} />
        </ChartCard>
        <ChartCard title="Completion rate" description="Completed ÷ all tickets in view." table={metricsTable(rows, COMPARE_LABEL[by], ["tickets", "completed", "completion_rate"])}>
          <BarListChart
            kind="pct"
            labelWidth={140}
            valueLabel="Completion rate"
            data={rows.map((r, i) => ({ label: labelOf(r), value: ratio(r.completed, r.tickets) ?? 0, color: colorFor(by, r.key, i), detail: `${fmtInt(r.completed)} of ${fmtInt(r.tickets)}` }))}
          />
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Median durations (hours)"
          description="Recorded first response vs. resolution. Medians exclude tickets without the timestamp."
          info="Recorded response = responded_at − created_at; resolution = resolved_at − created_at. Recorded response timestamps are system values and may not reflect a human reply."
          table={metricsTable(rows, COMPARE_LABEL[by], ["response_n", "response_median_s", "response_p90_s", "resolution_n", "resolution_median_s", "resolution_p90_s"])}
        >
          <ColumnChart
            categoryKey="label"
            kind="hours"
            yTickFormat="hours"
            data={rows.map((r) => ({ label: r.label.replace(/^(DECI|DEMI) — /, "$1 "), response: hours(r.response_median_s), resolution: hours(r.resolution_median_s) }))}
            series={[
              { key: "response", label: "Median recorded response", color: SERIES_COLORS[0] },
              { key: "resolution", label: "Median resolution", color: SERIES_COLORS[1] },
            ]}
          />
        </ChartCard>
        <ChartCard
          title="Over the resolution threshold"
          description={`Share of resolved tickets taking longer than ${fmtDuration(metrics.thresholds.resolution_seconds)} (illustrative threshold, not an SLA).`}
          table={metricsTable(rows, COMPARE_LABEL[by], ["resolution_n", "resolution_breach_rate", "open_breaches"])}
        >
          <BarListChart
            kind="pct"
            labelWidth={140}
            valueLabel="Over threshold"
            data={rows.map((r, i) => ({ label: r.label, value: ratio(r.resolution_breaches, r.resolution_n) ?? 0, color: colorFor(by, r.key, i), detail: `${fmtInt(r.resolution_breaches)} of ${fmtInt(r.resolution_n)} resolved tickets` }))}
          />
        </ChartCard>
      </div>

      <section className="flex flex-col gap-3">
        <SectionHeading title="Top reported issues" description="Most frequent topics within each group, with their share of that group's tickets." />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {topIssues.map(({ group, top }, i) => (
            <Card key={group.key} className="gap-3 shadow-xs">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: colorFor(by, group.key, i) }} aria-hidden />
                  {group.label}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {top.map((c) => {
                  const s = ratio(c.count, group.tickets) ?? 0;
                  return (
                    <div key={c.row} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate" title={c.row}>
                          {c.row}
                        </span>
                        <span className="tabular shrink-0 text-muted-foreground">
                          {fmtInt(c.count)} · {fmtPct(s, 0)}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted">
                        <div className="h-1.5 rounded-full" style={{ width: `${Math.max(2, s * 100)}%`, background: colorFor(by, group.key, i) }} />
                      </div>
                    </div>
                  );
                })}
                {by === "project" && (
                  <Link href={hrefWithFilters(`/projects/${group.key}`, ctx.filters)} className="inline-flex items-center gap-1 pt-1 text-xs font-medium hover:underline">
                    Project detail <ArrowRight className="size-3" />
                  </Link>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
