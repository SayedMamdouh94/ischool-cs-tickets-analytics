import type { Metadata } from "next";
import { Info } from "lucide-react";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { PageActions } from "@/components/dashboard/page-actions";
import { ChartCard } from "@/components/dashboard/chart-card";
import { ComparisonTable } from "@/components/dashboard/comparison-table";
import { DataTable } from "@/components/dashboard/data-table";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { SectionHeading } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/states";
import { BarListChart } from "@/components/charts/bar-list-chart";
import { SERIES_COLORS } from "@/components/charts/colors";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireViewer } from "@/lib/auth/dal";
import { getCrossTab, getDataQuality, getGroupedMetrics, resolveFilterContext } from "@/lib/analytics/queries";
import type { CrossTab, GroupMetrics } from "@/lib/analytics/types";
import { hrefWithFilters, NONE_TOKEN, type SearchParamsRecord } from "@/lib/filters/schema";
import { fmtDateTime, fmtInt, fmtPct, keyLabel, ratio } from "@/lib/format";
import type { TableData } from "@/lib/table-data";

export const metadata: Metadata = { title: "Support Team" };

/** Durations for a person are only shown when based on at least this many tickets. */
const MIN_N = 20;

export default function TeamPage({ searchParams }: PageProps<"/team">) {
  return (
    <DashboardPage
      title="Support Team"
      description="Workload by recorded responder and by recorded resolver. These are different activities in the export and are never merged."
      searchParams={searchParams}
      actions={<PageActions aggregate={[{ dataset: "responders", label: "Responder metrics" }, { dataset: "resolvers", label: "Resolver metrics" }]} />}
    >
      <TeamContent searchParams={searchParams} />
    </DashboardPage>
  );
}

function personTable(rows: GroupMetrics[], kind: "responder" | "resolver", filters: Parameters<typeof hrefWithFilters>[1]): TableData {
  return {
    columns: [
      { key: "label", label: kind === "responder" ? "Responder (Responder_Name)" : "Resolver (Resolved_By)" },
      { key: "tickets", label: "Tickets", kind: "int" },
      { key: "share", label: "Share", kind: "pct" },
      { key: "open", label: "Unresolved now", kind: "int" },
      ...(kind === "responder"
        ? [
            { key: "median", label: `Median recorded response (n ≥ ${MIN_N})`, kind: "duration" as const },
            { key: "generic", label: "Generic acknowledgement", kind: "pct" as const },
          ]
        : [
            { key: "median", label: `Median resolution (n ≥ ${MIN_N})`, kind: "duration" as const },
            { key: "breach", label: "Over resolution threshold", kind: "pct" as const },
          ]),
    ],
    rows: rows.map((r) => {
      const n = kind === "responder" ? r.response_n : r.resolution_n;
      const total = rows.reduce((a, x) => a + x.tickets, 0);
      return {
        key: r.key,
        label: keyLabel(r.key, "Not recorded"),
        href: hrefWithFilters("/tickets", { ...filters, [kind === "responder" ? "responders" : "resolvers"]: [r.key] }),
        tickets: r.tickets,
        share: ratio(r.tickets, total),
        open: r.open_tickets,
        median: r.key === NONE_TOKEN || n < MIN_N ? null : kind === "responder" ? r.response_median_s : r.resolution_median_s,
        generic: ratio(r.generic_ack, r.tickets),
        breach: ratio(r.resolution_breaches, r.resolution_n),
      };
    }),
  };
}

function crossTable(tab: CrossTab, label: string, projects: { code: string; name: string }[]): TableData {
  const people = [...new Set(tab.cells.map((c) => c.row))];
  const rows = people.map((p) => {
    const cells = tab.cells.filter((c) => c.row === p);
    return {
      label: keyLabel(p),
      ...Object.fromEntries(projects.map((pr) => [pr.code, cells.find((c) => c.col === pr.code)?.count ?? 0])),
      total: cells.reduce((a, c) => a + c.count, 0),
    };
  });
  rows.sort((a, b) => b.total - a.total);
  return {
    columns: [{ key: "label", label }, ...projects.map((p) => ({ key: p.code, label: p.name, kind: "int" as const })), { key: "total", label: "Total", kind: "int" as const }],
    rows,
  };
}

async function TeamContent({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  await requireViewer();
  const ctx = await resolveFilterContext(await searchParams);
  const [overallM, responders, resolvers, respByProject, resByProject, dq] = await Promise.all([
    getGroupedMetrics(ctx.rpc, "none"),
    getGroupedMetrics(ctx.rpc, "responder", 200),
    getGroupedMetrics(ctx.rpc, "resolver", 200),
    getCrossTab(ctx.rpc, "responder", "project"),
    getCrossTab(ctx.rpc, "resolver", "project"),
    getDataQuality(ctx.rpc),
  ]);
  const o = overallM.rows[0];
  if (!o || o.tickets === 0) return <EmptyState />;

  const c = dq.consistency as Record<string, number>;
  const projects = ctx.options.projects.map((p) => ({ code: p.code, name: p.name }));
  const named = (rows: GroupMetrics[]) => rows.filter((r) => r.key !== NONE_TOKEN);

  return (
    <div className="flex flex-col gap-6">
      <Alert>
        <Info />
        <AlertTitle className="text-sm">Read these figures as workload, not individual performance</AlertTitle>
        <AlertDescription className="text-xs leading-relaxed">
          {fmtPct(ratio(o.generic_ack, o.tickets))} of tickets carry a templated acknowledgement as their response, and for{" "}
          {fmtPct(ratio(c.responded_equals_resolved ?? 0, o.tickets))} the recorded response and resolution times are identical — so &ldquo;recorded response&rdquo;
          often marks when a ticket was actioned, not a first human reply. {fmtInt(dq.bulk_resolution_events.reduce((a, b) => a + b.tickets, 0))} tickets were closed in bulk
          events (10+ tickets at the same second). Durations are shown only for people with at least {MIN_N} tickets, and the tables are sorted by volume, not by speed.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Named responders" value={fmtInt(named(responders.rows).length)} info="Distinct Responder_Name values in view." sub={`${fmtInt(o.tickets - o.with_response_ts)} tickets without a responder`} />
        <KpiCard label="Named resolvers" value={fmtInt(named(resolvers.rows).length)} info="Distinct Resolved_By values in view." sub={`${fmtInt(o.tickets - o.with_resolution_ts)} tickets without a resolver`} />
        <KpiCard
          label="Responder ≠ resolver"
          value={fmtPct(ratio(c.responder_differs_from_resolver ?? 0, o.tickets))}
          info="Share of tickets where both names are recorded and differ — evidence that the two fields capture different activities."
          sub={`${fmtInt(c.responder_differs_from_resolver ?? 0)} tickets`}
        />
        <KpiCard label="Unresolved in view" value={fmtInt(o.open_tickets)} info="Pending or missing-status tickets without a resolution timestamp in the latest exports." sub="Not attributable to a resolver" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Tickets by recorded responder" description="Top 15 by volume. Click through in the table to see the tickets." table={personTable(responders.rows, "responder", ctx.filters)}>
          <BarListChart labelWidth={190} data={named(responders.rows).slice(0, 15).map((r) => ({ label: r.key, value: r.tickets, color: SERIES_COLORS[0] }))} />
        </ChartCard>
        <ChartCard title="Tickets by recorded resolver" description="Top 15 by volume." table={personTable(resolvers.rows, "resolver", ctx.filters)}>
          <BarListChart labelWidth={190} data={named(resolvers.rows).slice(0, 15).map((r) => ({ label: r.key, value: r.tickets, color: SERIES_COLORS[1] }))} />
        </ChartCard>
      </div>

      <section className="flex flex-col gap-3">
        <SectionHeading title="Responders" description="Recorded first-response activity. Click a name to open their tickets." />
        <ComparisonTable table={personTable(responders.rows, "responder", ctx.filters)} filters={ctx.filters} exportName="responders" />
      </section>
      <section className="flex flex-col gap-3">
        <SectionHeading title="Resolvers" description="Recorded resolution activity." />
        <ComparisonTable table={personTable(resolvers.rows, "resolver", ctx.filters)} filters={ctx.filters} exportName="resolvers" />
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-3 shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Responder workload by project</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable table={crossTable(respByProject, "Responder", projects)} maxHeight={420} />
          </CardContent>
        </Card>
        <Card className="gap-3 shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Resolver workload by project</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable table={crossTable(resByProject, "Resolver", projects)} maxHeight={420} />
          </CardContent>
        </Card>
      </div>

      {dq.bulk_resolution_events.length > 0 && (
        <Card className="gap-3 shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Bulk resolution events</CardTitle>
            <CardDescription className="text-xs">Ten or more tickets sharing the exact same resolution second — typically batch closures. Resolution durations for these tickets reflect the batch time.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              maxHeight={300}
              table={{
                columns: [
                  { key: "resolved_at", label: "Resolved at (Cairo)" },
                  { key: "resolved_by", label: "Resolver" },
                  { key: "tickets", label: "Tickets", kind: "int" },
                ],
                rows: dq.bulk_resolution_events.map((b) => ({ resolved_at: fmtDateTime(b.resolved_at), resolved_by: keyLabel(b.resolved_by), tickets: b.tickets })),
              }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
