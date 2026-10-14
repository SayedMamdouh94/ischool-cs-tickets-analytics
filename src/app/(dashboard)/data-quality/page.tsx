import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, CircleAlert, CircleHelp, Info, TriangleAlert } from "lucide-react";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { PageActions } from "@/components/dashboard/page-actions";
import { ChartCard } from "@/components/dashboard/chart-card";
import { DataTable } from "@/components/dashboard/data-table";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { SectionHeading } from "@/components/dashboard/page-header";
import { BarListChart } from "@/components/charts/bar-list-chart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireViewer } from "@/lib/auth/dal";
import { getCrossTab, getDataQuality, getImportRuns, resolveFilterContext } from "@/lib/analytics/queries";
import type { SearchParamsRecord } from "@/lib/filters/schema";
import { RESPONSE_KIND_LABELS, fmtCalendarDate, fmtDateTime, fmtInt, fmtPct, ratio } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Data Quality" };

type Kind = "error" | "anomaly" | "missing" | "pattern" | "ok";

const KIND_META: Record<Kind, { label: string; icon: typeof Info; className: string }> = {
  error: { label: "Error", icon: CircleAlert, className: "text-[var(--status-critical)]" },
  anomaly: { label: "Anomaly", icon: TriangleAlert, className: "text-[var(--status-serious)]" },
  missing: { label: "Missing information", icon: CircleHelp, className: "text-muted-foreground" },
  pattern: { label: "Pattern / caveat", icon: Info, className: "text-[var(--series-1)]" },
  ok: { label: "No issue", icon: CheckCircle2, className: "text-[var(--status-good)]" },
};

const FIELD_NOTES: Record<string, { kind: Kind; note: string }> = {
  Status: { kind: "error", note: "Every ticket should carry a status. Kept as missing — never coerced to pending." },
  Priority: { kind: "missing", note: "Column is empty in all exports. No priority levels are inferred." },
  Affected_Student_ID: { kind: "missing", note: "Column is empty in all exports." },
  Responded_At: { kind: "missing", note: "No response timestamp recorded. Excluded from response statistics." },
  Responder_Name: { kind: "missing", note: "No responder recorded (coincides with missing Responded_At)." },
  Resolved_At: { kind: "missing", note: "No resolution timestamp: unresolved, rejected, or not recorded." },
  Resolved_By: { kind: "missing", note: "No resolver recorded." },
  Response: { kind: "missing", note: "No response text." },
  Note: { kind: "pattern", note: "Agent notes are optional free text." },
  Attachment_URLs: { kind: "pattern", note: "Most tickets have no attachment." },
  Response_Attachment_URLs: { kind: "pattern", note: "Responses rarely include attachments." },
};

function KindBadge({ kind }: { kind: Kind }) {
  const m = KIND_META[kind];
  const Icon = m.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap", m.className)}>
      <Icon className="size-3.5" aria-hidden />
      {m.label}
    </span>
  );
}

export default function DataQualityPage({ searchParams }: PageProps<"/data-quality">) {
  return (
    <DashboardPage
      title="Data Quality"
      description="Gaps, inconsistencies and anomalies in the imported exports, with file-level reconciliation. Field statistics respect the filters; import history and reconciliation are global."
      searchParams={searchParams}
      actions={<PageActions aggregate={[{ dataset: "data_quality", label: "Missing values by field" }]} />}
    >
      <DataQualityContent searchParams={searchParams} />
    </DashboardPage>
  );
}

async function DataQualityContent({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  await requireViewer();
  const ctx = await resolveFilterContext(await searchParams);
  const [dq, runs, statusByProject] = await Promise.all([getDataQuality(ctx.rpc), getImportRuns(100), getCrossTab({}, "status", "project")]);
  const c = dq.consistency as Record<string, number>;
  const total = dq.total;
  const rejectedImportRows = dq.import_errors.reduce((a, e) => a + e.count, 0);
  const offsetMismatches = dq.reconciliation.reduce((a, r) => a + (r.reconciliation.offset_mismatches_vs_cairo ?? 0), 0);

  const findings: { name: string; count: number; kind: Kind; note: string }[] = [
    { name: "Missing status", count: c.missing_status, kind: c.missing_status ? "error" : "ok", note: "Status column blank. Shown as 'Missing status'; excluded from pending counts." },
    { name: "Completed without a resolution timestamp", count: c.completed_without_resolved_at, kind: c.completed_without_resolved_at ? "anomaly" : "ok", note: "Status says completed but Resolved_At is empty. Excluded from resolution durations." },
    { name: "Completed without a response timestamp", count: c.completed_without_responded_at, kind: c.completed_without_responded_at ? "missing" : "ok", note: "Closed tickets with no Responded_At — the response step was not recorded." },
    { name: "Pending with a resolution timestamp", count: c.pending_with_resolved_at, kind: c.pending_with_resolved_at ? "anomaly" : "ok", note: "Contradictory status and timestamps." },
    { name: "Resolved before the recorded response", count: c.resolved_before_responded, kind: c.resolved_before_responded ? "anomaly" : "ok", note: "Resolved_At earlier than Responded_At. Both durations remain valid relative to creation; the ordering suggests the two timestamps are written by different processes." },
    { name: "Responded before created", count: c.responded_before_created, kind: c.responded_before_created ? "error" : "ok", note: "Negative recorded response time; such values are excluded from statistics." },
    { name: "Resolved before created", count: c.resolved_before_created, kind: c.resolved_before_created ? "error" : "ok", note: "Negative resolution time; excluded from statistics." },
    { name: "Response and resolution at the same instant", count: c.responded_equals_resolved, kind: "pattern", note: "The recorded response timestamp often equals the resolution — it marks when a ticket was actioned, not a first reply." },
    { name: "Templated acknowledgement as response text", count: dq.response_kinds.generic_acknowledgement ?? 0, kind: "pattern", note: "Response text is a generic 'request received' template. Not evidence of a human reply." },
    { name: "Repeat submissions (same student, session and topic)", count: dq.repeat_submissions.same_session_tickets, kind: dq.repeat_submissions.same_session_tickets ? "pattern" : "ok", note: `${fmtInt(dq.repeat_submissions.same_session_groups)} groups. Possible duplicates by the same student; counted as separate tickets.` },
    { name: "Repeat submissions (same student, topic and day)", count: dq.repeat_submissions.same_day_topic_tickets, kind: dq.repeat_submissions.same_day_topic_tickets ? "pattern" : "ok", note: `${fmtInt(dq.repeat_submissions.same_day_topic_groups)} groups.` },
    { name: "Bulk resolution events (10+ at the same second)", count: dq.bulk_resolution_events.reduce((a, b) => a + b.tickets, 0), kind: dq.bulk_resolution_events.length ? "pattern" : "ok", note: `${fmtInt(dq.bulk_resolution_events.length)} events. Resolution durations reflect batch closure time.` },
    { name: "Duplicate ticket IDs in database", count: dq.duplicate_ticket_ids_in_db, kind: dq.duplicate_ticket_ids_in_db ? "error" : "ok", note: "Ticket_ID is the primary key; cross-project collisions are rejected at import." },
    { name: "Rejected import records", count: rejectedImportRows, kind: rejectedImportRows ? "error" : "ok", note: "Rows that failed validation or mapping; logged in import_errors, never silently dropped." },
    { name: "Timestamp offsets inconsistent with Africa/Cairo", count: offsetMismatches, kind: offsetMismatches ? "anomaly" : "ok", note: "Offsets (+0200 / +0300) checked against Egypt's daylight-saving rules at import." },
  ];

  const missingRows = dq.missing_by_field.map((f) => ({
    label: f.field,
    missing: f.missing,
    share: ratio(f.missing, total),
    kind: f.missing === 0 ? "No issue" : KIND_META[FIELD_NOTES[f.field]?.kind ?? "missing"].label,
    note: f.missing === 0 ? "Always present." : (FIELD_NOTES[f.field]?.note ?? ""),
  }));

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Tickets checked" value={fmtInt(total)} info="Tickets in the current filter selection." />
        <KpiCard label="Errors" value={fmtInt(findings.filter((f) => f.kind === "error").reduce((a, f) => a + f.count, 0))} info="Records that violate a rule that should always hold (e.g. a missing status)." />
        <KpiCard label="Anomalies" value={fmtInt(findings.filter((f) => f.kind === "anomaly").reduce((a, f) => a + f.count, 0))} info="Plausible but contradictory records (e.g. resolved before the recorded response)." />
        <KpiCard label="Rejected at import" value={fmtInt(rejectedImportRows)} info="Source rows logged as invalid during import (all files, all runs)." />
      </div>

      <Card className="gap-3 shadow-xs">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Findings</CardTitle>
          <CardDescription className="text-xs">Each check is classified as an error, an anomaly, missing information, or a known pattern that affects interpretation.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>Check</TableHead>
                <TableHead className="text-right">Tickets</TableHead>
                <TableHead className="text-right">Share</TableHead>
                <TableHead>Classification</TableHead>
                <TableHead>Interpretation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {findings.map((f) => (
                <TableRow key={f.name}>
                  <TableCell className="font-medium">{f.name}</TableCell>
                  <TableCell className="tabular text-right">{fmtInt(f.count)}</TableCell>
                  <TableCell className="tabular text-right">{fmtPct(ratio(f.count, total), 2)}</TableCell>
                  <TableCell>
                    <KindBadge kind={f.count === 0 ? "ok" : f.kind} />
                  </TableCell>
                  <TableCell className="min-w-72 text-muted-foreground">{f.note}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="Missing values by field"
          description="Blank values in the source exports (stored as NULL; never fabricated)."
          table={{
            columns: [
              { key: "label", label: "Field" },
              { key: "missing", label: "Missing", kind: "int" },
              { key: "share", label: "Share", kind: "pct" },
              { key: "kind", label: "Classification" },
              { key: "note", label: "Interpretation" },
            ],
            rows: missingRows,
          }}
          exportName="missing-values"
        >
          <BarListChart
            kind="pct"
            valueLabel="Missing"
            labelWidth={170}
            data={missingRows.filter((r) => r.missing > 0).sort((a, b) => b.missing - a.missing).map((r) => ({ label: r.label, value: r.share ?? 0, color: "var(--status-neutral)", detail: `${fmtInt(r.missing)} tickets · ${r.kind}` }))}
          />
        </ChartCard>
        <ChartCard
          title="Response text types"
          description="Classification of the Response field."
          table={{ columns: [{ key: "label", label: "Type" }, { key: "count", label: "Tickets", kind: "int" }, { key: "share", label: "Share", kind: "pct" }], rows: Object.entries(dq.response_kinds).map(([k, v]) => ({ label: RESPONSE_KIND_LABELS[k] ?? k, count: v, share: ratio(v, total) })) }}
        >
          <BarListChart
            labelWidth={200}
            data={Object.entries(dq.response_kinds)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => ({ label: RESPONSE_KIND_LABELS[k] ?? k, value: v, color: k === "custom" ? "var(--series-1)" : "var(--status-neutral)", detail: fmtPct(ratio(v, total), 2) }))}
          />
        </ChartCard>
      </div>

      <section className="flex flex-col gap-3">
        <SectionHeading title="Dataset coverage" description="Date span of each project in the current view and the export snapshot used to age unresolved tickets." />
        <DataTable
          table={{
            columns: [
              { key: "name", label: "Project" },
              { key: "tickets", label: "Tickets", kind: "int" },
              { key: "first_date", label: "First ticket", kind: "date" },
              { key: "last_date", label: "Last ticket", kind: "date" },
              { key: "active_days", label: "Days with tickets", kind: "int" },
              { key: "snapshot", label: "Export snapshot (Cairo)" },
            ],
            rows: dq.coverage.map((p) => ({ ...p, snapshot: fmtDateTime(p.snapshot_at) })),
          }}
        />
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading title="File-level reconciliation" description="Latest successful import of each file compared with what the database holds now (all data, filters not applied)." />
        <div className="overflow-x-auto rounded-lg border">
          <Table className="text-xs">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Project</TableHead>
                <TableHead className="text-right">Rows in file</TableHead>
                <TableHead className="text-right">Rejected</TableHead>
                <TableHead className="text-right">In database from file</TableHead>
                <TableHead>Status counts (file → database)</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dq.reconciliation.map((r) => {
                const fileStatus = r.reconciliation.status_counts ?? {};
                const dbStatus = Object.fromEntries(statusByProject.cells.filter((x) => x.col === r.project).map((x) => [x.row, x.count]));
                const statusKeys = [...new Set([...Object.keys(fileStatus), ...Object.keys(dbStatus)])].sort();
                const statusOk = statusKeys.every((k) => (fileStatus[k] ?? 0) === (dbStatus[k] ?? 0));
                const countOk = r.records_in_file - r.rejected_count === r.db_tickets_from_file;
                return (
                  <TableRow key={r.import_run_id}>
                    <TableCell className="font-medium">
                      <Link href={`/settings/imports/${r.import_run_id}`} className="hover:underline">
                        {r.source_filename}
                      </Link>
                    </TableCell>
                    <TableCell>{r.project}</TableCell>
                    <TableCell className="tabular text-right">{fmtInt(r.records_in_file)}</TableCell>
                    <TableCell className="tabular text-right">{fmtInt(r.rejected_count)}</TableCell>
                    <TableCell className="tabular text-right">{fmtInt(r.db_tickets_from_file)}</TableCell>
                    <TableCell className="tabular">
                      {statusKeys.map((k) => `${k === "__none__" ? "missing" : k} ${fmtInt(fileStatus[k] ?? 0)}→${fmtInt(dbStatus[k] ?? 0)}`).join(" · ")}
                    </TableCell>
                    <TableCell>
                      <KindBadge kind={countOk && statusOk ? "ok" : "anomaly"} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          Row-by-row content checks (SHA-256 of every source row) are run with <code className="rounded bg-muted px-1">npm run db:validate</code> against the original files.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading title="Import history" description="Every import attempt, including idempotent re-runs." />
        <DataTable
          maxHeight={420}
          table={{
            columns: [
              { key: "started", label: "Started" },
              { key: "file", label: "File" },
              { key: "project", label: "Project" },
              { key: "status", label: "Status" },
              { key: "records", label: "Rows", kind: "int" },
              { key: "inserted", label: "Inserted", kind: "int" },
              { key: "updated", label: "Updated", kind: "int" },
              { key: "skipped", label: "Skipped", kind: "int" },
              { key: "rejected", label: "Rejected", kind: "int" },
              { key: "asof", label: "Data as of" },
            ],
            rows: runs.map((r) => ({
              started: fmtDateTime(r.started_at),
              file: r.source_filename,
              project: r.project,
              status: r.status,
              records: r.records_in_file,
              inserted: r.inserted_count,
              updated: r.updated_count,
              skipped: r.skipped_count,
              rejected: r.rejected_count,
              asof: r.data_as_of ? fmtCalendarDate(r.data_as_of.slice(0, 10)) : null,
            })),
          }}
        />
        {dq.import_errors.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {dq.import_errors.map((e) => (
              <Badge key={e.error_code} variant="outline">
                {e.error_code}: {fmtInt(e.count)}
              </Badge>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
