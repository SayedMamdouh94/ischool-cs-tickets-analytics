import type { Metadata } from "next";
import Link from "next/link";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { PageActions } from "@/components/dashboard/page-actions";
import { ChartCard } from "@/components/dashboard/chart-card";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { SectionHeading } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/states";
import { ComparisonTable } from "@/components/dashboard/comparison-table";
import { ColumnChart } from "@/components/charts/column-chart";
import { BarListChart } from "@/components/charts/bar-list-chart";
import { TrendChart } from "@/components/charts/trend-chart";
import { SERIES_COLORS, projectColor } from "@/components/charts/colors";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireViewer } from "@/lib/auth/dal";
import { getBacklog, getDurationHistogram, getGroupedMetrics, resolveFilterContext } from "@/lib/analytics/queries";
import { metricsTable } from "@/lib/analytics/tables";
import { hrefWithFilters, type SearchParamsRecord } from "@/lib/filters/schema";
import { AGE_BUCKET_LABELS, DURATION_BUCKET_LABELS, fmtDateTime, fmtDuration, fmtInt, fmtPct, keyLabel, ratio, statusLabel } from "@/lib/format";

export const metadata: Metadata = { title: "Backlog & Resolution" };

export default function BacklogPage({ searchParams }: PageProps<"/backlog">) {
  return (
    <DashboardPage
      title="Backlog & Resolution"
      description="Unresolved tickets as of each project's latest export, how long resolution takes, and where the illustrative thresholds are exceeded."
      searchParams={searchParams}
      actions={<PageActions aggregate={[{ dataset: "backlog", label: "Unresolved tickets by age" }, { dataset: "resolution_distribution", label: "Resolution distribution" }]} />}
    >
      <BacklogContent searchParams={searchParams} />
    </DashboardPage>
  );
}

async function BacklogContent({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  await requireViewer();
  const ctx = await resolveFilterContext(await searchParams);
  const [overallM, projectsM, topicsM, backlog, histogram] = await Promise.all([
    getGroupedMetrics(ctx.rpc, "none"),
    getGroupedMetrics(ctx.rpc, "project"),
    getGroupedMetrics(ctx.rpc, "topic"),
    getBacklog(ctx.rpc, 25),
    getDurationHistogram(ctx.rpc, "resolution", "project"),
  ]);
  const o = overallM.rows[0];
  if (!o || o.tickets === 0) return <EmptyState />;

  const resTh = overallM.thresholds.resolution_seconds;
  const respTh = overallM.thresholds.response_seconds;
  const projects = ctx.options.projects;
  const projectName = Object.fromEntries(projects.map((p) => [p.code, p.name]));

  const ageRows = Object.entries(AGE_BUCKET_LABELS).map(([bucket, label]) => ({
    label,
    ...Object.fromEntries(projects.map((p) => [p.code, backlog.open.filter((x) => x.age_bucket === bucket && x.project === p.code).reduce((a, x) => a + x.count, 0)])),
  }));
  const histRows = DURATION_BUCKET_LABELS.map((label, i) => ({
    label,
    ...Object.fromEntries(projects.map((p) => [p.code, histogram.bins.find((b) => b.bucket === i && b.key === p.code)?.count ?? 0])),
  }));
  const projectSeries = projects.map((p) => ({ key: p.code, label: p.name, color: projectColor(p.code) }));
  const oldestAge = backlog.oldest[0]?.age_seconds ?? null;

  const slowTopics = topicsM.rows.filter((t) => t.resolution_n >= 20).sort((a, b) => (b.resolution_median_s ?? 0) - (a.resolution_median_s ?? 0));
  const reconstructed = backlog.reconstructed.map((r) => ({ bucket: r.date, s0: r.open }));

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Unresolved" value={fmtInt(o.open_tickets)} info="Status classified as open (pending, missing, or not yet classified — see Settings → Categories) and no resolution timestamp, in the latest export of each project." sub={`${fmtInt(o.pending)} pending · ${fmtInt(o.missing_status)} no status`} />
        <KpiCard label="Unresolved over threshold" value={fmtInt(o.open_breaches)} info={`Unresolved tickets older than ${fmtDuration(resTh)} at their project's export snapshot.`} sub={`${fmtPct(ratio(o.open_breaches, o.open_tickets), 0)} of unresolved`} />
        <KpiCard label="Oldest unresolved" value={fmtDuration(oldestAge)} info="Age of the oldest unresolved ticket at its project's export snapshot (not today)." />
        <KpiCard label="Median resolution" value={fmtDuration(o.resolution_median_s)} info="Median of resolved_at − created_at for tickets with a resolution timestamp." sub={`Average ${fmtDuration(o.resolution_avg_s)}`} />
        <KpiCard label="Resolved over threshold" value={fmtPct(ratio(o.resolution_breaches, o.resolution_n), 0)} info={`Share of resolved tickets whose resolution took longer than ${fmtDuration(resTh)}. Illustrative threshold, not an SLA.`} sub={`${fmtInt(o.resolution_breaches)} tickets`} />
        <KpiCard label="No resolution timestamp" value={fmtInt(o.tickets - o.with_resolution_ts)} info="Tickets without Resolved_At (any status). Excluded from duration statistics and reported here instead." sub="Excluded from duration statistics" />
      </div>

      <Alert>
        <AlertTitle className="text-sm">How thresholds are applied</AlertTitle>
        <AlertDescription className="text-xs leading-relaxed">
          A resolved ticket breaches the resolution threshold ({fmtDuration(resTh)}) when resolved_at − created_at exceeds it; an unresolved ticket breaches it when it was older than the
          threshold at its project&apos;s export snapshot. The recorded-response threshold ({fmtDuration(respTh)}) applies to responded_at − created_at. Both are illustrative monitoring values
          editable in <Link href="/settings" className="underline">Settings</Link> — not contractual SLAs.
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="Unresolved tickets by age"
          description="Age at each project's export snapshot."
          table={{ columns: [{ key: "label", label: "Age" }, ...projects.map((p) => ({ key: p.code, label: p.name, kind: "int" as const }))], rows: ageRows }}
        >
          <ColumnChart categoryKey="label" data={ageRows} series={projectSeries} stacked height={260} />
        </ChartCard>
        <ChartCard title="Unresolved by topic" table={{ columns: [{ key: "topic", label: "Topic" }, { key: "count", label: "Unresolved", kind: "int" }], rows: backlog.open_by_topic }}>
          {backlog.open_by_topic.length === 0 ? (
            <EmptyState title="No unresolved tickets" description="Every ticket in view has a final status." />
          ) : (
            <BarListChart labelWidth={230} data={backlog.open_by_topic.map((t) => ({ label: t.topic, value: t.count, color: "var(--status-warning)" }))} />
          )}
        </ChartCard>
      </div>

      <Card className="gap-3 shadow-xs">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Longest outstanding tickets</CardTitle>
          <CardDescription className="text-xs">Unresolved in the latest export, oldest first. Ages are measured at the export snapshot.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {backlog.oldest.length === 0 ? (
            <EmptyState title="No unresolved tickets" />
          ) : (
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Ticket</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Topic</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Recorded response</TableHead>
                  <TableHead className="text-right">Age at snapshot</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backlog.oldest.map((t) => (
                  <TableRow key={t.ticket_id}>
                    <TableCell>
                      <Link href={hrefWithFilters("/tickets", ctx.filters, {}, { ticket: String(t.ticket_id) })} className="tabular font-medium hover:underline">
                        #{t.ticket_id}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{t.project_name}</TableCell>
                    <TableCell className="max-w-64 truncate" title={t.topic}>
                      {t.topic}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-normal">
                        {statusLabel(t.status === "__none__" ? null : t.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular whitespace-nowrap">{fmtDateTime(t.created_at)}</TableCell>
                    <TableCell className="tabular whitespace-nowrap">{t.responded_at ? `${fmtDateTime(t.responded_at)} · ${keyLabel(t.responder_name)}` : "—"}</TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {fmtDuration(t.age_seconds)}
                      {t.breaches_resolution_threshold && <span className="ml-1.5 text-[var(--status-critical)]">over</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3">
        <SectionHeading title="Resolution durations" description="resolved_at − created_at for tickets with a valid resolution timestamp." />
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard
            title="Resolution time distribution"
            description={`Tickets per duration band, by project. Excluded: ${fmtInt(histogram.excluded.missing)} without a resolution timestamp${histogram.excluded.negative ? `, ${fmtInt(histogram.excluded.negative)} with negative duration` : ""}.`}
            table={{ columns: [{ key: "label", label: "Duration" }, ...projects.map((p) => ({ key: p.code, label: p.name, kind: "int" as const }))], rows: histRows }}
          >
            <ColumnChart categoryKey="label" data={histRows} series={projectSeries} height={280} />
          </ChartCard>
          <ChartCard
            title="Topics with longer resolution"
            description="Median resolution by topic (n ≥ 20 resolved tickets)."
            table={metricsTable(slowTopics, "Topic", ["resolution_n", "resolution_median_s", "resolution_p90_s", "resolution_breach_rate"])}
          >
            <BarListChart
              kind="duration"
              valueLabel="Median resolution"
              labelWidth={230}
              data={slowTopics.map((t) => ({ label: t.key, value: t.resolution_median_s ?? 0, color: SERIES_COLORS[1], detail: `P90 ${fmtDuration(t.resolution_p90_s)} · ${fmtPct(ratio(t.resolution_breaches, t.resolution_n), 0)} over threshold` }))}
            />
          </ChartCard>
        </div>
        <ComparisonTable
          filters={ctx.filters}
          linkBase="/projects"
          exportName="threshold_breaches"
          colorKeys={Object.fromEntries(projects.map((p) => [p.code, projectColor(p.code)]))}
          table={metricsTable(projectsM.rows, "Project", ["resolution_n", "resolution_median_s", "resolution_avg_s", "resolution_p90_s", "resolution_breach_rate", "response_n", "response_median_s", "response_breach_rate", "open_tickets", "open_breaches"])}
        />
      </section>

      <ChartCard
        title="Reconstructed open tickets over time"
        description="Built only from timestamps: tickets created minus tickets resolved by each day. The exports contain no status history, so this is an approximation — tickets without a resolution timestamp are excluded."
        table={{ columns: [{ key: "date", label: "Date", kind: "date" }, { key: "open", label: "Open (reconstructed)", kind: "int" }, { key: "created", label: "Created", kind: "int" }, { key: "resolved", label: "Resolved", kind: "int" }], rows: backlog.reconstructed }}
      >
        <TrendChart data={reconstructed} series={[{ key: "s0", label: "Open (reconstructed)", color: SERIES_COLORS[6] }]} grain="day" variant="area" height={260} />
      </ChartCard>

      <p className="text-xs text-muted-foreground">
        Export snapshots: {backlog.snapshots.map((s) => `${projectName[s.project] ?? s.project} ${fmtDateTime(s.snapshot_at)}`).join(" · ")} (Africa/Cairo).
      </p>
    </div>
  );
}
