import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { PageActions } from "@/components/dashboard/page-actions";
import { ChartCard } from "@/components/dashboard/chart-card";
import { ComparisonTable } from "@/components/dashboard/comparison-table";
import { DataTable } from "@/components/dashboard/data-table";
import { SectionHeading } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/states";
import { BarListChart } from "@/components/charts/bar-list-chart";
import { TrendChart } from "@/components/charts/trend-chart";
import { ACCENT, SERIES_COLORS } from "@/components/charts/colors";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireViewer } from "@/lib/auth/dal";
import { getCrossTab, getGroupedMetrics, getRecurringSessions, getVolumeSeries, resolveFilterContext } from "@/lib/analytics/queries";
import { pivotSeries } from "@/lib/analytics/shape";
import { metricsTable } from "@/lib/analytics/tables";
import { hrefWithFilters, type SearchParamsRecord } from "@/lib/filters/schema";
import { fmtDuration, fmtInt, fmtPct, keyLabel, ratio } from "@/lib/format";

export const metadata: Metadata = { title: "Topics & Complaints" };

export default function TopicsPage({ searchParams }: PageProps<"/topics">) {
  return (
    <DashboardPage
      title="Topics & Complaints"
      description="What students report, how often, and how long it takes to resolve. Topics are chosen by students when filing; they describe the request, not a verified root cause."
      searchParams={searchParams}
      filterKeys={["date", "projects", "programs", "intakes", "statuses", "topics", "categories", "subcategories"]}
      actions={<PageActions aggregate={[{ dataset: "topics", label: "Topic metrics" }, { dataset: "themes", label: "Issue themes" }, { dataset: "lessons", label: "Lessons" }]} />}
    >
      <TopicsContent searchParams={searchParams} />
    </DashboardPage>
  );
}

async function TopicsContent({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  await requireViewer();
  const ctx = await resolveFilterContext(await searchParams);
  const [overallM, topicsM, byProject, categoriesM, themesM, topicThemes, recurring, lessons, themeTrendSeries] = await Promise.all([
    getGroupedMetrics(ctx.rpc, "none"),
    getGroupedMetrics(ctx.rpc, "topic"),
    getCrossTab(ctx.rpc, "topic", "project"),
    getGroupedMetrics(ctx.rpc, "category"),
    getGroupedMetrics(ctx.rpc, "subcategory"),
    getCrossTab(ctx.rpc, "topic", "subcategory"),
    getRecurringSessions(ctx.rpc, 2, 25),
    getGroupedMetrics(ctx.rpc, "lesson", 16),
    getVolumeSeries(ctx.rpc, "week", "subcategory"),
  ]);
  const o = overallM.rows[0];
  if (!o || o.tickets === 0) return <EmptyState />;

  const themeName = Object.fromEntries(ctx.options.categories.map((c) => [c.code, c.name]));
  const focusTopic = ctx.filters.topics.length === 1 ? ctx.filters.topics[0] : null;

  const topicTable = metricsTable(topicsM.rows, "Topic", ["tickets", "share", "pending", "open_tickets", "resolution_median_s", "resolution_p90_s", "resolution_breach_rate"], { total: o.tickets });
  topicTable.rows = topicTable.rows.map((r) => ({ ...r, href: hrefWithFilters("/topics", ctx.filters, { topics: [String(r.key)] }) }));

  const projects = ctx.options.projects;
  const matrix = {
    columns: [{ key: "label", label: "Topic" }, ...projects.map((p) => ({ key: p.code, label: p.name, kind: "int" as const })), { key: "total", label: "Total", kind: "int" as const }],
    rows: topicsM.rows.map((t) => {
      const cells = byProject.cells.filter((c) => c.row === t.key);
      return {
        label: t.key,
        ...Object.fromEntries(projects.map((p) => [p.code, cells.find((c) => c.col === p.code)?.count ?? 0])),
        total: t.tickets,
      };
    }),
  };

  const themes = themesM.rows.filter((r) => r.key !== "__none__");
  const themeTrend = pivotSeries(
    { ...themeTrendSeries, points: themeTrendSeries.points.filter((p) => !["no_free_text", "unmatched", "__none__"].includes(p.key)) },
    { colorFor: (_, i) => SERIES_COLORS[i], labelFor: (k) => themeName[k] ?? k, topN: 5 },
  );

  const focusThemes = focusTopic
    ? topicThemes.cells.filter((c) => c.row === focusTopic).sort((a, b) => b.count - a.count)
    : [];
  const focusTotal = focusThemes.reduce((a, c) => a + c.count, 0);

  return (
    <div className="flex flex-col gap-6">
      {focusTopic && (
        <Card className="gap-3 border-primary/30 shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Focus: {focusTopic}</CardTitle>
            <CardDescription className="text-xs">
              {fmtInt(o.tickets)} tickets · {fmtInt(o.open_tickets)} unresolved · median resolution {fmtDuration(o.resolution_median_s)} · {fmtInt(o.unique_owners)} students
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Issue themes in this topic (keyword rules)</p>
              <BarListChart
                labelWidth={200}
                data={focusThemes.slice(0, 8).map((c) => ({ label: themeName[c.col] ?? keyLabel(c.col), value: c.count, color: ACCENT, detail: fmtPct(ratio(c.count, focusTotal)) }))}
              />
            </div>
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-xs font-medium text-muted-foreground">Next steps</p>
              <Link href={hrefWithFilters("/tickets", ctx.filters)} className="inline-flex items-center gap-1 hover:underline">
                Read the tickets in this topic <ArrowRight className="size-3.5" />
              </Link>
              <Link href={hrefWithFilters("/trends", ctx.filters)} className="inline-flex items-center gap-1 hover:underline">
                See this topic over time <ArrowRight className="size-3.5" />
              </Link>
              <Link href={hrefWithFilters("/backlog", ctx.filters)} className="inline-flex items-center gap-1 hover:underline">
                Resolution and backlog for this topic <ArrowRight className="size-3.5" />
              </Link>
              <Link href={hrefWithFilters("/topics", ctx.filters, { topics: [] })} className="inline-flex items-center gap-1 text-muted-foreground hover:underline">
                Clear topic focus
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      <section className="flex flex-col gap-3">
        <SectionHeading title="Topics" description="Click a topic to focus the page on it. Share is of all tickets in view." />
        <ComparisonTable table={topicTable} filters={ctx.filters} exportName="topics" />
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Topic share" description="Tickets per topic." table={metricsTable(topicsM.rows, "Topic", ["tickets", "share"], { total: o.tickets })}>
          <BarListChart labelWidth={240} data={topicsM.rows.map((r) => ({ label: r.key, value: r.tickets, detail: `${fmtPct(ratio(r.tickets, o.tickets))} of tickets` }))} />
        </ChartCard>
        <ChartCard
          title="Resolution time by topic"
          description="Median resolved_at − created_at; topics with fewer than 20 resolved tickets are omitted from the chart."
          table={metricsTable(topicsM.rows, "Topic", ["resolution_n", "resolution_median_s", "resolution_avg_s", "resolution_p90_s"])}
        >
          <BarListChart
            kind="duration"
            valueLabel="Median resolution"
            labelWidth={240}
            data={topicsM.rows
              .filter((r) => r.resolution_n >= 20)
              .sort((a, b) => (b.resolution_median_s ?? 0) - (a.resolution_median_s ?? 0))
              .map((r) => ({ label: r.key, value: r.resolution_median_s ?? 0, color: SERIES_COLORS[1], detail: `n=${fmtInt(r.resolution_n)} · P90 ${fmtDuration(r.resolution_p90_s)}` }))}
          />
        </ChartCard>
      </div>

      <Card className="gap-3 shadow-xs">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Topics by project</CardTitle>
          <CardDescription className="text-xs">Ticket counts per topic and project.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable table={matrix} maxHeight={420} />
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3">
        <SectionHeading
          title="Recurring complaints"
          description="Analytical categories group the source topics; issue themes are detected from the student's free text with Arabic and English keyword rules."
        />
        <Alert>
          <AlertTitle className="text-sm">How to read issue themes</AlertTitle>
          <AlertDescription className="text-xs">
            Themes come from deterministic keyword matching (rules-v1, run locally — no text is sent to external services). They indicate what a message mentions, not a verified cause.
            &ldquo;Structured request&rdquo; means the form captured only session fields and no free text.
          </AlertDescription>
        </Alert>
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard title="Analytical categories" description="Grouping of source topics." table={metricsTable(categoriesM.rows, "Category", ["tickets", "share", "pending", "resolution_median_s"], { total: o.tickets })}>
            <BarListChart labelWidth={220} data={categoriesM.rows.map((r) => ({ label: r.label, value: r.tickets, detail: fmtPct(ratio(r.tickets, o.tickets)) }))} />
          </ChartCard>
          <ChartCard title="Issue themes" description="Primary theme per ticket." table={metricsTable(themes, "Theme", ["tickets", "share", "pending", "resolution_median_s"], { total: o.tickets })}>
            <BarListChart labelWidth={220} data={themes.map((r) => ({ label: r.label, value: r.tickets, color: ["no_free_text", "unmatched"].includes(r.key) ? "var(--status-neutral)" : SERIES_COLORS[0], detail: fmtPct(ratio(r.tickets, o.tickets)) }))} />
          </ChartCard>
        </div>
        <ChartCard
          title="Theme trends"
          description="Weekly tickets for the five most frequent themes (excluding structured requests and unmatched text)."
          table={{ columns: [{ key: "bucket", label: "Week starting", kind: "date" }, ...themeTrend.series.map((s) => ({ key: s.key, label: s.label, kind: "int" as const }))], rows: themeTrend.data }}
        >
          <TrendChart data={themeTrend.data} series={themeTrend.series} grain="week" height={280} />
        </ChartCard>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card id="recurring" className="scroll-mt-20 gap-3 shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Sessions reported by several students</CardTitle>
            <CardDescription className="text-xs">
              {fmtInt(recurring.summary.recurring_sessions)} of {fmtInt(recurring.summary.sessions_with_tickets)} referenced sessions were reported by {recurring.summary.min_students}+ different students
              ({fmtInt(recurring.summary.tickets_in_recurring_sessions)} tickets). Repeat submissions by one student are not counted as recurrence.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {recurring.summary.recurring_sessions === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No session ID in this selection was reported by more than one student. In these exports a Session ID identifies one student&apos;s session booking rather than a
                shared class, so recurring problems are better read at lesson level (right) and through the issue themes above.
              </p>
            ) : (
            <ComparisonTable
              filters={ctx.filters}
              exportName="recurring_sessions"
              table={{
                columns: [
                  { key: "label", label: "Session" },
                  { key: "project", label: "Project" },
                  { key: "lesson", label: "Lesson" },
                  { key: "students", label: "Students", kind: "int" },
                  { key: "tickets", label: "Tickets", kind: "int" },
                  { key: "open", label: "Unresolved", kind: "int" },
                  { key: "first", label: "First ticket", kind: "datetime" },
                ],
                rows: recurring.sessions.map((s) => ({
                  key: s.session_ref,
                  label: s.session_ref,
                  href: hrefWithFilters("/tickets", { ...ctx.filters, session: s.session_ref }),
                  project: s.project_code,
                  lesson: s.lesson_name,
                  students: s.students,
                  tickets: s.tickets,
                  open: s.open_tickets,
                  first: s.first_created_at,
                })),
              }}
            />
            )}
          </CardContent>
        </Card>
        <Card className="gap-3 shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Lessons with the most tickets</CardTitle>
            <CardDescription className="text-xs">Lesson names parsed from structured session messages; tickets without a lesson are excluded.</CardDescription>
          </CardHeader>
          <CardContent>
            <ComparisonTable
              filters={ctx.filters}
              exportName="lessons"
              table={{
                ...metricsTable(lessons.rows.filter((r) => r.key !== "__none__").slice(0, 15), "Lesson", ["tickets", "unique_owners", "open_tickets", "resolution_median_s"]),
                rows: metricsTable(lessons.rows.filter((r) => r.key !== "__none__").slice(0, 15), "Lesson", ["tickets", "unique_owners", "open_tickets", "resolution_median_s"]).rows.map((r) => ({
                  ...r,
                  href: hrefWithFilters("/tickets", { ...ctx.filters, lesson: String(r.key) }),
                })),
              }}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
