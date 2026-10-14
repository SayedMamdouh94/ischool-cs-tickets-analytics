import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { DataTable } from "@/components/dashboard/data-table";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { PageSkeleton } from "@/components/dashboard/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireViewer } from "@/lib/auth/dal";
import { getImportRunDetail } from "@/lib/analytics/queries";
import { fmtDateTime, fmtInt } from "@/lib/format";

export const metadata: Metadata = { title: "Import report" };

export default function ImportRunPage({ params }: PageProps<"/settings/imports/[id]">) {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5">
      <Link href="/settings" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Settings & Imports
      </Link>
      <Suspense fallback={<PageSkeleton />}>
        <ImportRunContent params={params} />
      </Suspense>
    </div>
  );
}

async function ImportRunContent({ params }: { params: Promise<{ id: string }> }) {
  await requireViewer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detail = await getImportRunDetail(id);
  if (!detail) notFound();
  const { run } = detail;
  const rec = run.reconciliation as {
    status_counts?: Record<string, number>;
    missing?: Record<string, number>;
    anomalies?: Record<string, number>;
    offsets?: Record<string, number>;
    offset_mismatches_vs_cairo?: number;
    multiline?: Record<string, number>;
    attachments?: Record<string, number>;
  };

  const kv = (o: Record<string, number> | undefined, label: string) => ({
    columns: [{ key: "k", label }, { key: "v", label: "Count", kind: "int" as const }],
    rows: Object.entries(o ?? {}).map(([k, v]) => ({ k: k === "__none__" ? "(missing)" : k.replace(/_/g, " "), v })),
  });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={`Import report: ${run.source_filename}`} description={`${run.project_name ?? "Unmapped"} · started ${fmtDateTime(run.started_at)} · status ${run.status.replace(/_/g, " ")}`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Rows in file" value={fmtInt(run.records_in_file)} info="Data records parsed from the CSV (header excluded; multi-line records count once)." />
        <KpiCard label="Inserted" value={fmtInt(run.inserted_count)} info="New tickets written by this run." />
        <KpiCard label="Updated" value={fmtInt(run.updated_count)} info="Existing tickets whose content changed and whose export was at least as recent." />
        <KpiCard label="Unchanged" value={fmtInt(run.skipped_unchanged_count)} info="Rows identical to the stored ticket (same SHA-256 of source values)." />
        <KpiCard label="Stale (skipped)" value={fmtInt(run.skipped_stale_count)} info="Rows from an export older than the one that last wrote the ticket. Not applied (update policy)." />
        <KpiCard label="Rejected" value={fmtInt(run.rejected_count)} info="Rows logged in import_errors with a reason." />
      </div>
      <Card className="gap-3 shadow-xs">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Run details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <p>
            <span className="text-muted-foreground">File SHA-256:</span> <code className="break-all">{run.file_hash}</code>
          </p>
          <p>
            <span className="text-muted-foreground">Data as of:</span> {fmtDateTime(run.data_as_of)}
          </p>
          <p>
            <span className="text-muted-foreground">Created range:</span> {fmtDateTime(run.min_created_at)} – {fmtDateTime(run.max_created_at)}
          </p>
          <p>
            <span className="text-muted-foreground">Update policy:</span> {run.update_policy}
          </p>
          <p>
            <span className="text-muted-foreground">Importer:</span> v{run.importer_version}
          </p>
          <p>
            <span className="text-muted-foreground">Timestamp offsets not matching Cairo:</span> {fmtInt(rec.offset_mismatches_vs_cairo ?? 0)}
          </p>
          {run.duplicate_of_run_id && <p className="sm:col-span-2">Identical file previously imported (run {run.duplicate_of_run_id}); this run verified it idempotently.</p>}
          {run.error_summary && <p className="text-destructive sm:col-span-3">{run.error_summary}</p>}
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <DataTable table={kv(rec.status_counts, "Status in file")} />
        <DataTable table={kv(rec.anomalies, "Anomaly")} />
        <DataTable table={kv(rec.offsets, "UTC offset")} />
      </div>
      <DataTable table={kv(rec.missing, "Blank values per column")} maxHeight={360} />
      <Card className="gap-3 shadow-xs">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Rejected rows ({fmtInt(detail.errors.length)})</CardTitle>
          <CardDescription className="text-xs">
            {detail.raw_rows_visible ? "Raw row payloads are shown to administrators only." : "Raw row payloads are hidden for analysts."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {detail.errors.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rows were rejected in this run.</p>
          ) : (
            <DataTable
              maxHeight={480}
              table={{
                columns: [
                  { key: "row", label: "Row", kind: "int" },
                  { key: "ticket", label: "Ticket" },
                  { key: "code", label: "Code" },
                  { key: "error", label: "Validation error" },
                  ...(detail.raw_rows_visible ? [{ key: "raw", label: "Raw row (truncated)" }] : []),
                ],
                rows: detail.errors.map((e) => ({
                  row: e.source_row_number,
                  ticket: e.ticket_id ? String(e.ticket_id) : null,
                  code: e.error_code,
                  error: e.validation_error,
                  raw: e.raw_row ? JSON.stringify(e.raw_row).slice(0, 300) : null,
                })),
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
