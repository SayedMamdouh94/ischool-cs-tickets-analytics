"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, ArrowRight, Ban, Check, CheckCircle2, Download, FileWarning, Info, Loader2, RefreshCw, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { JobStatusBadge } from "./status-badges";
import { cancelImport, confirmImport, refreshPreview, retryImport } from "@/lib/imports/actions";
import { ISSUE_CODE_HELP } from "@/lib/imports/constants";
import type { ImportIssueRow, ImportJobDetail, ImportJobStatus, InvalidRowPolicy } from "@/lib/imports/types";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { cn } from "@/lib/utils";

const TERMINAL: ImportJobStatus[] = ["completed", "completed_with_errors", "failed", "cancelled"];
const STEPS: { key: string; label: string; statuses: ImportJobStatus[] }[] = [
  { key: "upload", label: "Uploaded", statuses: ["awaiting_upload", "uploaded"] },
  { key: "validate", label: "Validating", statuses: ["validating"] },
  { key: "ready", label: "Ready for confirmation", statuses: ["ready"] },
  { key: "import", label: "Importing", statuses: ["importing"] },
  { key: "done", label: "Completed", statuses: ["completed", "completed_with_errors"] },
];

function stepIndex(d: ImportJobDetail): number {
  const s = d.job.status;
  if (s === "failed" || s === "cancelled") {
    if (d.job.import_run_id) return 3;
    return d.job.preview ? 2 : 1;
  }
  return STEPS.findIndex((x) => x.statuses.includes(s));
}

export function JobMonitor({ initial, issues, issuesTotal }: { initial: ImportJobDetail; issues: ImportIssueRow[]; issuesTotal: number }) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  // With invalid rows the administrator must choose the policy explicitly; otherwise all-or-nothing applies.
  const [chosenPolicy, setPolicy] = useState<InvalidRowPolicy | null>(null);
  const [pending, start] = useTransition();
  const lastStatus = useRef(initial.job.status);
  const job = detail.job;
  const terminal = TERMINAL.includes(job.status);

  // A server refresh delivers a new snapshot: adopt it (adjusting state during render, not in an effect).
  const [seenInitial, setSeenInitial] = useState(initial);
  if (seenInitial !== initial) {
    setSeenInitial(initial);
    setDetail(initial);
  }

  // Poll while the job is moving; the status endpoint also restarts a stalled worker.
  useEffect(() => {
    if (terminal || job.status === "ready") return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/imports/jobs/${job.id}`, { cache: "no-store" });
        if (res.ok && !stop) {
          const next = (await res.json()) as ImportJobDetail;
          setDetail(next);
          if (next.job.status !== lastStatus.current) {
            lastStatus.current = next.job.status;
            router.refresh(); // reload issues / history rendered on the server
          }
        }
      } catch {
        // transient network error: keep polling
      }
    };
    const t = setInterval(tick, 2000);
    void tick();
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [job.id, job.status, terminal, router]);

  const act = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      router.refresh();
    });

  const preview = job.preview;
  const counts = preview?.counts;
  const policy: InvalidRowPolicy | null = counts && counts.invalid > 0 ? (chosenPolicy === "import_valid_rows" ? chosenPolicy : null) : "all_or_nothing";
  const summary = job.validation_summary ?? {};
  const errors = detail.issue_counts.filter((i) => i.severity === "error").reduce((a, i) => a + i.count, 0);
  const warnings = detail.issue_counts.filter((i) => i.severity === "warning").reduce((a, i) => a + i.count, 0);
  const pct = job.status === "importing" || job.status === "completed" || job.status === "completed_with_errors"
    ? job.rows_to_apply ? Math.round((job.rows_applied / job.rows_to_apply) * 100) : 100
    : job.progress_total ? Math.round((job.progress_done / job.progress_total) * 100) : 0;
  const targetLabel = detail.project?.name ?? job.new_project?.name ?? "—";

  return (
    <div className="flex flex-col gap-4">
      <Card className="shadow-xs">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{job.original_filename}</p>
              <p className="text-xs text-muted-foreground">
                {job.mode === "upsert" ? "Add / update" : `Archive & start new (${job.archive_scope === "cycle" ? `cycle ${detail.archive_cycle?.code}` : `project ${detail.archive_project?.code}`})`} → {targetLabel} ·{" "}
                {job.file_format.toUpperCase()} · {fmtBytes(job.file_size_bytes ?? job.declared_size_bytes)} · created {fmtDateTime(job.created_at)}
                {detail.created_by_email ? ` by ${detail.created_by_email}` : ""}
              </p>
            </div>
            <JobStatusBadge status={job.status} stalled={detail.stalled} />
          </div>

          <ol className="grid grid-cols-5 gap-1" aria-label="Import progress">
            {STEPS.map((s, i) => {
              const idx = stepIndex(detail);
              const failedHere = (job.status === "failed" || job.status === "cancelled") && i === idx;
              const done = i < idx || (i === idx && (job.status === "completed" || job.status === "completed_with_errors"));
              const activeStep = i === idx && !done && !failedHere;
              return (
                <li key={s.key} className="flex flex-col gap-1">
                  <span className={cn("h-1.5 rounded-full bg-muted", done && "bg-emerald-500", activeStep && "bg-sky-500", failedHere && "bg-destructive")} />
                  <span className={cn("text-[11px] text-muted-foreground", (activeStep || failedHere) && "font-medium text-foreground")}>{s.label}</span>
                </li>
              );
            })}
          </ol>

          {(job.status === "uploaded" || job.status === "validating" || job.status === "importing") && (
            <div className="space-y-1.5" aria-live="polite">
              <div className="flex justify-between text-xs">
                <span>
                  {job.status === "importing"
                    ? `Importing: ${fmtInt(job.rows_applied)} of ${fmtInt(job.rows_to_apply)} rows applied (atomic batches)`
                    : job.status === "uploaded"
                      ? "Queued for validation…"
                      : `Validating: ${job.progress_phase ?? "reading"} ${job.progress_total ? `${fmtInt(job.progress_done)} of ${fmtInt(job.progress_total)} rows` : ""}`}
                </span>
                <span className="tabular">{pct}%</span>
              </div>
              <Progress value={pct} className="h-2" />
              <p className="text-[11px] text-muted-foreground">
                Runs in the background — you can leave this page. {detail.stalled ? "The worker is restarting; progress continues where it stopped." : ""}
              </p>
            </div>
          )}

          {job.status === "failed" && (
            <div role="alert" className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <p className="flex items-center gap-2 font-medium text-destructive">
                <XCircle className="size-4" /> {job.import_run_id ? "The import stopped before finishing" : "The file was rejected"}
              </p>
              <p className="text-destructive">{job.last_error}</p>
              {job.import_run_id ? (
                <p className="text-xs text-muted-foreground">
                  {fmtInt(job.rows_applied)} of {fmtInt(job.rows_to_apply)} rows were applied (each batch is complete and consistent). Retry resumes from where it stopped.
                  {job.mode === "archive_and_start" ? " The old project/cycle is still active; the new project stays hidden until the import completes." : ""}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Nothing was imported. Fix the file (see the issues below) and upload it again.</p>
              )}
              <div className="flex flex-wrap gap-2">
                {(job.import_run_id || job.uploaded_at) && (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => retryImport(job.id))}>
                    <RotateCcw /> Retry
                  </Button>
                )}
                <CancelButton jobId={job.id} disabled={pending} partial={job.rows_applied > 0} archiveMode={job.mode === "archive_and_start"} onConfirm={() => act(() => cancelImport(job.id))} />
              </div>
            </div>
          )}

          {job.status === "cancelled" && <p className="text-sm text-muted-foreground">This import was cancelled{job.cancelled_at ? ` on ${fmtDateTime(job.cancelled_at)}` : ""}.</p>}
        </CardContent>
      </Card>

      {counts && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label={job.mode === "archive_and_start" ? "Tickets (new project)" : "New tickets"} value={counts.new} tone="good" />
          <Stat label="Existing tickets updated" value={counts.updated} tone={counts.updated ? "info" : undefined} />
          <Stat label="Unchanged" value={counts.unchanged} />
          <Stat label="Older export (not applied)" value={counts.stale} tone={counts.stale ? "warn" : undefined} />
          <Stat label="Invalid rows" value={counts.invalid} tone={counts.invalid ? "bad" : undefined} />
          <Stat label="Warnings" value={warnings} tone={warnings ? "warn" : undefined} />
        </div>
      )}

      {job.status === "ready" && counts && (
        <Card className="border-primary/40 shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Review and confirm</CardTitle>
            <CardDescription className="text-xs">
              Preview computed {fmtDateTime(job.preview_computed_at)} against the current database. Rows in the file: {fmtInt(counts.total)}.
              {preview && preview.absent_existing > 0 && ` ${fmtInt(preview.absent_existing)} existing tickets are not in this file — they are kept unchanged (never deleted).`}
              {job.mode === "archive_and_start" &&
                ` On success, ${job.archive_scope === "cycle" ? `cycle ${detail.archive_cycle?.name}` : detail.archive_project?.name} is archived and ${job.new_project?.name} becomes active.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs font-medium">Rows with blocking errors ({fmtInt(counts.invalid)})</p>
              <ToggleGroup type="single" variant="outline" value={policy ?? ""} onValueChange={(v) => setPolicy(v ? (v as InvalidRowPolicy) : null)} className="flex-wrap justify-start">
                <ToggleGroupItem value="all_or_nothing" className="h-auto px-3 py-2 text-left text-xs" disabled={counts.invalid > 0}>
                  All or nothing — import only if every row is valid
                </ToggleGroupItem>
                <ToggleGroupItem value="import_valid_rows" className="h-auto px-3 py-2 text-left text-xs">
                  Import valid rows only — record invalid rows as rejected
                </ToggleGroupItem>
              </ToggleGroup>
              <p className="text-[11px] text-muted-foreground">
                {policy === "import_valid_rows"
                  ? `${fmtInt(counts.valid)} valid rows are imported; ${fmtInt(counts.invalid)} invalid rows are stored as rejected rows with their reasons in the import report (never silently dropped).`
                  : counts.invalid > 0
                    ? `Choose how to proceed: fix the ${fmtInt(counts.invalid)} invalid row(s) and upload the file again, or select "Import valid rows only". All-or-nothing is not possible while rows are invalid.`
                    : "Every row is valid; all of them will be imported."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={pending || counts.valid === 0 || policy === null}
                onClick={() =>
                  start(async () => {
                    if (!policy) return;
                    const r = await confirmImport({ id: job.id, policy, previewVersion: job.preview_version });
                    if (r.ok) toast.success(r.message);
                    else if (r.data?.previewChanged) toast.warning(r.message);
                    else toast.error(r.message);
                    router.refresh();
                  })
                }
              >
                {pending ? <Loader2 className="animate-spin" /> : <Check />} Confirm import of {fmtInt(counts.valid)} rows
              </Button>
              <Button variant="outline" disabled={pending} onClick={() => act(() => refreshPreview(job.id))}>
                <RefreshCw /> Recompute preview
              </Button>
              <CancelButton jobId={job.id} disabled={pending} onConfirm={() => act(() => cancelImport(job.id))} />
            </div>
          </CardContent>
        </Card>
      )}

      {detail.run && (job.status === "completed" || job.status === "completed_with_errors" || job.status === "importing" || job.status === "failed") && (
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              {job.status === "completed" || job.status === "completed_with_errors" ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Info className="size-4" />} Import report
            </CardTitle>
            <CardDescription className="text-xs">
              {job.status.startsWith("completed")
                ? `Finished ${fmtDateTime(detail.run.completed_at)}. All dashboards already use the new data.`
                : "Counts so far (updated as batches complete)."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Inserted" value={detail.run.inserted_count} tone="good" />
              <Stat label="Updated" value={detail.run.updated_count} />
              <Stat label="Unchanged" value={detail.run.skipped_unchanged_count} />
              <Stat label="Older export (skipped)" value={detail.run.skipped_stale_count} />
              <Stat label="Rejected" value={detail.run.rejected_count} tone={detail.run.rejected_count ? "bad" : undefined} />
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Button asChild size="sm" variant="outline">
                <Link href={`/settings/imports/${detail.run.id}`}>
                  Detailed run report <ArrowRight />
                </Link>
              </Button>
              {job.status.startsWith("completed") && detail.project && (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/projects/${detail.project.code}`}>
                    Open {detail.project.name} <ArrowRight />
                  </Link>
                </Button>
              )}
              {job.status.startsWith("completed") && (
                <Button asChild size="sm" variant="outline">
                  <Link href="/insights">
                    Updated insights <ArrowRight />
                  </Link>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {preview && (preview.conflicts.regressions > 0 || preview.conflicts.stale_rows > 0 || preview.conflicts.collisions > 0 || Object.keys(preview.field_changes).length > 0 || preview.conflicts.ids_in_other_cycles_or_archived > 0) && (
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <ShieldAlert className="size-4" /> Changes and conflicts
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm md:grid-cols-2">
            <ul className="space-y-1.5">
              {preview.conflicts.stale_rows > 0 && <li>• {fmtInt(preview.conflicts.stale_rows)} row(s) come from an older export than the stored ticket and will not be applied.</li>}
              {preview.conflicts.regressions > 0 && <li>• {fmtInt(preview.conflicts.regressions)} update(s) would remove information (e.g. clear Resolved_At). Listed as warnings below.</li>}
              {preview.conflicts.collisions > 0 && <li>• {fmtInt(preview.conflicts.collisions)} Ticket_ID(s) already belong to another project of this cycle (rejected).</li>}
              {preview.conflicts.ids_in_other_cycles_or_archived > 0 && (
                <li>• {fmtInt(preview.conflicts.ids_in_other_cycles_or_archived)} Ticket_ID(s) also exist in archived projects or other cycles; those records stay separate.</li>
              )}
              {preview.ids_in_archived_target > 0 && <li>• {fmtInt(preview.ids_in_archived_target)} ticket(s) also exist in the data being archived; the archived copies remain unchanged.</li>}
            </ul>
            {Object.keys(preview.field_changes).length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium">Fields changed by the updates</p>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {Object.entries(preview.field_changes)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <li key={k} className="flex justify-between">
                        <span>{k}</span>
                        <span className="tabular text-muted-foreground">{fmtInt(v)}</span>
                      </li>
                    ))}
                </ul>
                <p className="mt-2 text-[11px] text-muted-foreground">Previous values are kept in each ticket&apos;s history.</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {(issuesTotal > 0 || errors > 0) && (
        <Card className="shadow-xs">
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <FileWarning className="size-4" /> Validation findings
              </CardTitle>
              <CardDescription className="text-xs">
                {fmtInt(errors)} blocking error(s) · {fmtInt(warnings)} warning(s). Blocking errors reject the row; warnings are imported and flagged.
              </CardDescription>
            </div>
            <Button asChild size="sm" variant="outline">
              <a href={`/api/imports/jobs/${job.id}/report`} download>
                <Download /> Download validation report (CSV)
              </a>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {detail.issue_counts.map((i) => (
                <span
                  key={`${i.severity}-${i.code}`}
                  title={ISSUE_CODE_HELP[i.code]}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]",
                    i.severity === "error" && "border-destructive/40 text-destructive",
                    i.severity === "warning" && "border-amber-500/50 text-amber-800 dark:text-amber-300",
                  )}
                >
                  {i.severity === "error" ? <Ban className="size-3" /> : i.severity === "warning" ? <AlertTriangle className="size-3" /> : <Info className="size-3" />}
                  {i.code.replace(/_/g, " ").toLowerCase()} · {fmtInt(i.count)}
                </span>
              ))}
            </div>
            <div className="max-h-[480px] overflow-auto rounded-lg border">
              <Table className="text-xs">
                <TableHeader className="sticky top-0 bg-muted">
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Row</TableHead>
                    <TableHead className="text-right">Line</TableHead>
                    <TableHead>Ticket</TableHead>
                    <TableHead>Column</TableHead>
                    <TableHead>Problem</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {issues.map((i, n) => (
                    <TableRow key={n}>
                      <TableCell>
                        <span className={cn("font-medium", i.severity === "error" && "text-destructive", i.severity === "warning" && "text-amber-700 dark:text-amber-400")}>
                          {i.severity === "error" ? "Error" : i.severity === "warning" ? "Warning" : "Note"}
                        </span>
                        <span className="block text-[10px] text-muted-foreground">{i.code}</span>
                      </TableCell>
                      <TableCell className="tabular text-right">{i.row_number ?? "file"}</TableCell>
                      <TableCell className="tabular text-right">{i.line ?? "—"}</TableCell>
                      <TableCell className="tabular">{i.ticket_id ?? "—"}</TableCell>
                      <TableCell>{i.column_name ?? "—"}</TableCell>
                      <TableCell className="min-w-64">
                        <span dir="auto" className="user-text">
                          {i.message}
                        </span>
                        {i.value_excerpt && (
                          <code dir="auto" className="user-text mt-0.5 block text-[11px] text-muted-foreground">
                            {i.value_excerpt}
                          </code>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {issuesTotal > issues.length && (
              <p className="text-xs text-muted-foreground">
                Showing the first {fmtInt(issues.length)} of {fmtInt(issuesTotal)} findings. Download the report for the complete list.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {summary.stats && (
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">File summary</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
            <p>
              <span className="text-muted-foreground">Rows:</span> {fmtInt(summary.rows_total)} ({fmtInt(summary.rows_valid)} valid)
            </p>
            <p>
              <span className="text-muted-foreground">Data as of (latest timestamp):</span> {fmtDateTime(job.data_as_of)}
            </p>
            <p>
              <span className="text-muted-foreground">Created range:</span> {fmtDateTime(job.min_created_at)} – {fmtDateTime(job.max_created_at)}
            </p>
            <p>
              <span className="text-muted-foreground">Format:</span> {summary.format?.toUpperCase()}
              {summary.sheet ? ` · sheet "${summary.sheet}"` : ""}
              {summary.delimiter && summary.delimiter !== "," ? ` · delimiter "${summary.delimiter === "\t" ? "tab" : summary.delimiter}"` : ""}
            </p>
            {job.file_hash && (
              <p className="sm:col-span-2">
                <span className="text-muted-foreground">SHA-256:</span> <code className="break-all">{job.file_hash}</code>
              </p>
            )}
            {(summary.new_topics?.length ?? 0) > 0 && (
              <p className="sm:col-span-3">
                <span className="text-muted-foreground">New topics:</span> {summary.new_topics!.map((t) => `${t.topic} (${t.rows})`).join(" · ")} —{" "}
                <Link href="/settings?tab=categories" className="text-primary hover:underline">
                  map them to categories
                </Link>
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-1.5 text-xs">
            {detail.events.map((e, i) => (
              <li key={i} className="flex flex-wrap gap-x-3">
                <span className="tabular text-muted-foreground">{fmtDateTime(e.at)}</span>
                <span className="font-medium">{e.event.replace(/^job\./, "").replace(/_/g, " ")}</span>
                {e.email && <span className="text-muted-foreground">{e.email}</span>}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

export function fmtBytes(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "good" | "bad" | "warn" | "info" }) {
  return (
    <div className="rounded-lg border bg-card p-3 shadow-xs">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          "tabular text-xl font-semibold",
          tone === "good" && value > 0 && "text-emerald-700 dark:text-emerald-400",
          tone === "bad" && "text-destructive",
          tone === "warn" && "text-amber-700 dark:text-amber-400",
        )}
      >
        {fmtInt(value)}
      </p>
    </div>
  );
}

function CancelButton({ jobId, disabled, partial = false, archiveMode = false, onConfirm }: { jobId: string; disabled: boolean; partial?: boolean; archiveMode?: boolean; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-destructive" disabled={disabled} data-job={jobId}>
          <XCircle /> Cancel import
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this import?</DialogTitle>
          <DialogDescription>
            {partial
              ? archiveMode
                ? "The partially loaded new project is discarded (it was never visible). The archived project/cycle was never archived and stays active."
                : "Rows already applied stay in the project (they came from a valid, newer export); the run is recorded as stopped. Nothing else changes."
              : "No data has been imported. The uploaded file stays in private storage for the audit trail."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            Cancel import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
