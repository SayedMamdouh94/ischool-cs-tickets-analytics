import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/dashboard/page-header";
import { PrintButton } from "@/components/dashboard/print-button";
import { FilterSection } from "@/components/dashboard/filter-section";
import { FilterBarSkeleton, PageSkeleton } from "@/components/dashboard/states";
import { PendingContent } from "@/components/filters/filter-transition";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireViewer } from "@/lib/auth/dal";
import { loadInsights } from "@/lib/analytics/insights-loader";
import { getDataQuality, getGroupedMetrics, getSettings, resolveFilterContext } from "@/lib/analytics/queries";
import { DATE_PRESET_LABELS, type SearchParamsRecord } from "@/lib/filters/schema";
import { fmtCalendarDate, fmtDateTime, fmtDuration, fmtInt, fmtPct, ratio, statusLabel } from "@/lib/format";

export const metadata: Metadata = { title: "Management Summary" };

export default function SummaryPage({ searchParams }: PageProps<"/reports/summary">) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <PageHeader title="Management Summary" description="A printable one-document summary of the current filtered view." actions={<PrintButton />} />
      <div data-print-hide>
        <Suspense fallback={<FilterBarSkeleton />}>
          <FilterSection searchParams={searchParams} />
        </Suspense>
      </div>
      <PendingContent>
        <Suspense fallback={<PageSkeleton />}>
          <Summary searchParams={searchParams} />
        </Suspense>
      </PendingContent>
    </div>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-2 border-b pb-1 text-base font-semibold">{children}</h2>;
}

async function Summary({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const viewer = await requireViewer();
  const ctx = await resolveFilterContext(await searchParams);
  const [overallM, projectsM, topicsM, statusM, dq, settings, { insights }] = await Promise.all([
    getGroupedMetrics(ctx.rpc, "none"),
    getGroupedMetrics(ctx.rpc, "project"),
    getGroupedMetrics(ctx.rpc, "topic", 8),
    getGroupedMetrics(ctx.rpc, "status"),
    getDataQuality(ctx.rpc),
    getSettings(),
    loadInsights(ctx),
  ]);
  const o = overallM.rows[0];
  if (!o) return <p className="text-sm text-muted-foreground">No tickets match the current filters.</p>;
  const c = dq.consistency as Record<string, number>;
  const org = settings.app.organization_name ?? "";

  const filterText = [
    ctx.filters.preset === "all" ? "All available data" : `${DATE_PRESET_LABELS[ctx.filters.preset]}: ${fmtCalendarDate(ctx.range.from)} – ${fmtCalendarDate(ctx.range.to)}`,
    ctx.filters.projects.length ? `Projects: ${ctx.filters.projects.join(", ")}` : null,
    ctx.filters.programs.length ? `Programs: ${ctx.filters.programs.join(", ")}` : null,
    ctx.filters.intakes.length ? `Intakes: ${ctx.filters.intakes.join(", ")}` : null,
    ctx.filters.statuses.length ? `Statuses: ${ctx.filters.statuses.join(", ")}` : null,
    ctx.filters.topics.length ? `Topics: ${ctx.filters.topics.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="flex flex-col gap-4 text-sm leading-relaxed print:text-[11pt]">
      <header className="rounded-lg border p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{org} · Customer support ticket analytics</p>
        <p className="mt-1 font-medium">Scope: {filterText}</p>
        <p className="text-xs text-muted-foreground">
          Source: imported historical exports (data as of {fmtDateTime(ctx.options.latest_import.data_as_of)}, Africa/Cairo). Prepared by {viewer.email}.
        </p>
      </header>

      <H2>Headline figures</H2>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
        <p>Tickets: <strong>{fmtInt(o.tickets)}</strong></p>
        <p>Unique students: <strong>{fmtInt(o.unique_owners)}</strong></p>
        <p>Completion rate: <strong>{fmtPct(ratio(o.completed, o.tickets))}</strong></p>
        <p>Pending: <strong>{fmtInt(o.pending)}</strong></p>
        <p>Unresolved over threshold: <strong>{fmtInt(o.open_breaches)}</strong></p>
        <p>Median resolution: <strong>{fmtDuration(o.resolution_median_s)}</strong> (P90 {fmtDuration(o.resolution_p90_s)})</p>
        <p>Response timestamp recorded: <strong>{fmtPct(ratio(o.with_response_ts, o.tickets))}</strong></p>
        <p>Median recorded response: <strong>{fmtDuration(o.response_median_s)}</strong>*</p>
        <p>Resolved over {fmtDuration(overallM.thresholds.resolution_seconds)}: <strong>{fmtPct(ratio(o.resolution_breaches, o.resolution_n), 0)}</strong></p>
      </div>
      <p className="text-xs text-muted-foreground">
        * Recorded response times are system timestamps; {fmtPct(ratio(o.generic_ack, o.tickets))} of responses are templated acknowledgements, so they are not proof of a human reply.
        Thresholds are illustrative, not contractual SLAs.
      </p>

      <H2>Projects</H2>
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead className="text-right">Tickets</TableHead>
            <TableHead className="text-right">Completion</TableHead>
            <TableHead className="text-right">Unresolved</TableHead>
            <TableHead className="text-right">Median resolution</TableHead>
            <TableHead className="text-right">Over threshold</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projectsM.rows.map((p) => (
            <TableRow key={p.key}>
              <TableCell>{p.label}</TableCell>
              <TableCell className="tabular text-right">{fmtInt(p.tickets)}</TableCell>
              <TableCell className="tabular text-right">{fmtPct(ratio(p.completed, p.tickets))}</TableCell>
              <TableCell className="tabular text-right">{fmtInt(p.open_tickets)}</TableCell>
              <TableCell className="tabular text-right">{fmtDuration(p.resolution_median_s)}</TableCell>
              <TableCell className="tabular text-right">{fmtPct(ratio(p.resolution_breaches, p.resolution_n), 0)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <H2>Most frequent topics</H2>
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>Topic</TableHead>
            <TableHead className="text-right">Tickets</TableHead>
            <TableHead className="text-right">Share</TableHead>
            <TableHead className="text-right">Median resolution</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {topicsM.rows.map((t) => (
            <TableRow key={t.key}>
              <TableCell>{t.key}</TableCell>
              <TableCell className="tabular text-right">{fmtInt(t.tickets)}</TableCell>
              <TableCell className="tabular text-right">{fmtPct(ratio(t.tickets, o.tickets))}</TableCell>
              <TableCell className="tabular text-right">{fmtDuration(t.resolution_median_s)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">Status mix: {statusM.rows.map((s) => `${statusLabel(s.key === "__none__" ? null : s.key)} ${fmtInt(s.tickets)}`).join(" · ")}.</p>

      <H2>Observations</H2>
      <ol className="list-decimal space-y-2 pl-5">
        {insights.map((i) => (
          <li key={i.id}>
            <strong>{i.title}.</strong> <span className="text-muted-foreground">{i.statement}</span>
          </li>
        ))}
      </ol>

      <H2>Data limitations</H2>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        <li>Figures come from historical CSV exports; statuses reflect each export snapshot and no status history is available.</li>
        <li>{fmtInt(c.missing_responded_at)} tickets lack a response timestamp and {fmtInt(c.missing_resolved_at)} lack a resolution timestamp; they are excluded from duration statistics.</li>
        <li>{fmtInt(c.resolved_before_responded)} tickets were resolved before their recorded response; {fmtInt(c.missing_status)} have no status.</li>
        <li>Priority and Affected_Student_ID are empty in every export; no priority analysis is possible.</li>
        <li>Topics are chosen by students and issue themes come from keyword rules; neither is a verified root cause.</li>
      </ul>
    </article>
  );
}
