import type { Metadata } from "next";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { PageActions } from "@/components/dashboard/page-actions";
import { ChartCard } from "@/components/dashboard/chart-card";
import { EmptyState } from "@/components/dashboard/states";
import { SegmentedParam } from "@/components/filters/segmented-param";
import { TrendChart } from "@/components/charts/trend-chart";
import { ColumnChart } from "@/components/charts/column-chart";
import { WeekdayHourHeatmap } from "@/components/charts/heatmap";
import { ACCENT, INTAKE_GROUP_COLORS, PROGRAM_COLORS, SERIES_COLORS, projectColor } from "@/components/charts/colors";
import { DataTable } from "@/components/dashboard/data-table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireViewer } from "@/lib/auth/dal";
import { getPeriodComparison, getVolumeSeries, getWeekdayHour, resolveFilterContext } from "@/lib/analytics/queries";
import { detectSpikes } from "@/lib/analytics/anomalies";
import { pivotSeries, totalsByBucket } from "@/lib/analytics/shape";
import { relativeChange } from "@/lib/analytics/stats";
import type { Grain, SeriesSplit } from "@/lib/analytics/types";
import type { SearchParamsRecord } from "@/lib/filters/schema";
import { WEEKDAY_LABELS, fmtCalendarDate, fmtInt } from "@/lib/format";
import { pickParam } from "@/lib/search-params";

export const metadata: Metadata = { title: "Ticket Trends" };

const GRAINS = ["day", "week", "month"] as const;
const SPLITS = ["none", "project", "program", "intake_group"] as const;

export default function TrendsPage({ searchParams }: PageProps<"/trends">) {
  return (
    <DashboardPage
      title="Ticket Trends"
      description="How ticket volume changes over time, by weekday and hour (Africa/Cairo). Unusual increases are flagged statistically — causes are not inferred."
      searchParams={searchParams}
      actions={<PageActions aggregate={[{ dataset: "volume_daily", label: "Daily volume" }, { dataset: "topics_period", label: "Topic period comparison" }]} />}
    >
      <TrendsContent searchParams={searchParams} />
    </DashboardPage>
  );
}

async function TrendsContent({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  await requireViewer();
  const sp = await searchParams;
  const ctx = await resolveFilterContext(sp);
  const grain = pickParam(sp, "grain", GRAINS, "week") as Grain;
  const split = pickParam(sp, "split", SPLITS, "project") as SeriesSplit;

  const [series, daily, heat, periodTopics, periodProjects, topicWeekly] = await Promise.all([
    getVolumeSeries(ctx.rpc, grain, split),
    getVolumeSeries(ctx.rpc, "day", "none"),
    getWeekdayHour(ctx.rpc),
    getPeriodComparison(ctx.rpc, "topic", ctx.range.from ? null : 30),
    getPeriodComparison(ctx.rpc, "project", ctx.range.from ? null : 30),
    getVolumeSeries(ctx.rpc, grain === "day" ? "week" : grain, "topic"),
  ]);
  if (daily.points.length === 0) return <EmptyState />;

  const projectNames = Object.fromEntries(ctx.options.projects.map((p) => [p.code, p.name]));
  const trend = pivotSeries(series, {
    colorFor: (k, i) =>
      split === "project" ? projectColor(k, i) : split === "program" ? (PROGRAM_COLORS[k] ?? SERIES_COLORS[i]) : split === "intake_group" ? (INTAKE_GROUP_COLORS[k] ?? SERIES_COLORS[i]) : ACCENT,
    labelFor: (k) => (split === "project" ? (projectNames[k] ?? k) : k === "all" ? "Tickets" : k),
    order: split === "project" ? ctx.options.projects.map((p) => p.code) : undefined,
  });

  const spikes = detectSpikes(totalsByBucket(daily));
  const markers =
    grain === "day" && split === "none" ? spikes.map((s) => ({ bucket: s.date, value: s.count, label: `${s.count} tickets` })) : [];

  const weekday = WEEKDAY_LABELS.map((label, i) => ({
    label,
    tickets: heat.cells.filter((c) => c.isodow === i + 1).reduce((a, c) => a + c.count, 0),
  }));
  const hourly = Array.from({ length: 24 }, (_, h) => ({
    label: String(h).padStart(2, "0"),
    tickets: heat.cells.filter((c) => c.hour === h).reduce((a, c) => a + c.count, 0),
  }));

  const topicTrend = pivotSeries(topicWeekly, { colorFor: (_, i) => SERIES_COLORS[i], topN: 5 });

  const periodTable = (p: typeof periodTopics, label: string, labelFor?: (k: string) => string) => ({
    columns: [
      { key: "label", label },
      { key: "current", label: p.current ? `${fmtCalendarDate(p.current.from)} – ${fmtCalendarDate(p.current.to)}` : "Current", kind: "int" as const },
      { key: "previous", label: p.previous ? `${fmtCalendarDate(p.previous.from)} – ${fmtCalendarDate(p.previous.to)}` : "Previous", kind: "int" as const },
      { key: "change", label: "Change", kind: "int" as const },
      { key: "pct", label: "Change %", kind: "pct" as const },
    ],
    rows: p.rows.map((r) => ({
      label: labelFor ? labelFor(r.key) : (r.label ?? r.key),
      current: r.current,
      previous: r.previous,
      change: r.current - r.previous,
      pct: relativeChange(r.current, r.previous),
    })),
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedParam param="grain" label="Time grain" defaultValue="week" options={[{ value: "day", label: "Daily" }, { value: "week", label: "Weekly" }, { value: "month", label: "Monthly" }]} />
        <SegmentedParam
          param="split"
          label="Split by"
          defaultValue="project"
          options={[{ value: "none", label: "Total" }, { value: "project", label: "Project" }, { value: "program", label: "Program" }, { value: "intake_group", label: "Intake group" }]}
        />
      </div>

      <ChartCard
        title={`${grain === "day" ? "Daily" : grain === "week" ? "Weekly" : "Monthly"} ticket volume`}
        description={
          grain === "day" && split === "none"
            ? `Orange markers flag unusually high days (robust z ≥ 3.5 against the trailing 28-day median; ${spikes.length} found).`
            : "Switch to Daily + Total to see statistically unusual days. Partial first/last periods are expected at the data boundaries."
        }
        table={{ columns: [{ key: "bucket", label: grain === "month" ? "Month" : grain === "week" ? "Week starting" : "Date", kind: "date" }, ...trend.series.map((s) => ({ key: s.key, label: s.label, kind: "int" as const }))], rows: trend.data }}
      >
        <TrendChart data={trend.data} series={trend.series} grain={grain} height={320} markers={markers} />
      </ChartCard>

      {spikes.length > 0 && (
        <Card className="gap-3 shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Days with unusual volume</CardTitle>
            <CardDescription className="text-xs">Statistical flags only. Check platform incidents, deadlines or announcements around these dates before drawing conclusions.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              maxHeight={260}
              table={{
                columns: [
                  { key: "date", label: "Date", kind: "date" },
                  { key: "count", label: "Tickets", kind: "int" },
                  { key: "baseline", label: "Typical (28-day median)", kind: "int" },
                  { key: "score", label: "Robust z-score" },
                ],
                rows: spikes.map((s) => ({ ...s })),
              }}
              initialSort={{ key: "score", dir: "desc" }}
            />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Volume by weekday" description="Tickets by day of week of creation (Africa/Cairo)." table={{ columns: [{ key: "label", label: "Weekday" }, { key: "tickets", label: "Tickets", kind: "int" }], rows: weekday }}>
          <ColumnChart categoryKey="label" data={weekday} series={[{ key: "tickets", label: "Tickets", color: ACCENT }]} height={240} />
        </ChartCard>
        <ChartCard title="Volume by hour of day" description="Tickets by hour of creation (Africa/Cairo)." table={{ columns: [{ key: "label", label: "Hour" }, { key: "tickets", label: "Tickets", kind: "int" }], rows: hourly }}>
          <ColumnChart categoryKey="label" data={hourly} series={[{ key: "tickets", label: "Tickets", color: ACCENT }]} height={240} />
        </ChartCard>
      </div>

      <ChartCard
        title="When tickets are created"
        description="Weekday × hour of creation, Africa/Cairo. Darker cells mean more tickets."
        table={{
          columns: [{ key: "day", label: "Weekday" }, ...Array.from({ length: 24 }, (_, h) => ({ key: `h${h}`, label: String(h).padStart(2, "0"), kind: "int" as const }))],
          rows: WEEKDAY_LABELS.map((day, d) => ({
            day,
            ...Object.fromEntries(Array.from({ length: 24 }, (_, h) => [`h${h}`, heat.cells.find((c) => c.isodow === d + 1 && c.hour === h)?.count ?? 0])),
          })),
        }}
      >
        <WeekdayHourHeatmap cells={heat.cells} />
      </ChartCard>

      <ChartCard
        title="Topic trends"
        description={`Top five topics per ${grain === "month" ? "month" : "week"}; the rest are grouped as Other.`}
        table={{ columns: [{ key: "bucket", label: "Period starting", kind: "date" }, ...topicTrend.series.map((s) => ({ key: s.key, label: s.label, kind: "int" as const }))], rows: topicTrend.data }}
      >
        <TrendChart data={topicTrend.data} series={topicTrend.series} grain={grain === "day" ? "week" : grain} height={320} />
      </ChartCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-3 shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Period-over-period by topic</CardTitle>
            <CardDescription className="text-xs">
              {periodTopics.current && periodTopics.previous
                ? `${periodTopics.current.days}-day period ending ${fmtCalendarDate(periodTopics.current.to)} vs. the ${periodTopics.previous.days} days before. ${ctx.range.from ? "Uses the selected date range." : "Select a date range to compare a different period."}`
                : "Not enough data."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable table={periodTable(periodTopics, "Topic")} maxHeight={380} initialSort={{ key: "current", dir: "desc" }} />
          </CardContent>
        </Card>
        <Card className="gap-3 shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Period-over-period by project</CardTitle>
            <CardDescription className="text-xs">Same periods as the topic comparison. A project whose intake had ended will show a natural decline.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable table={periodTable(periodProjects, "Project", (k) => projectNames[k] ?? k)} maxHeight={380} />
            <p className="mt-2 text-xs text-muted-foreground">
              Total: {fmtInt(periodProjects.rows.reduce((a, r) => a + r.current, 0))} vs {fmtInt(periodProjects.rows.reduce((a, r) => a + r.previous, 0))} tickets.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
