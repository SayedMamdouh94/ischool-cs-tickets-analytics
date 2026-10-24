import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Lock, X } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { DataTable } from "@/components/dashboard/data-table";
import { PageSkeleton } from "@/components/dashboard/states";
import { AccessManager, InsightRulesForm, PreferencesForm, ThresholdForm } from "@/components/settings/forms";
import { CategoriesPanel } from "@/components/settings/categories-panel";
import { ImportWizard, TemplateCard } from "@/components/settings/import-wizard";
import { ProjectsPanel } from "@/components/settings/projects-panel";
import { JobStatusBadge } from "@/components/settings/status-badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireViewer } from "@/lib/auth/dal";
import { getAuditEvents, getImportJobs, getImportRuns, getSettings, getStatusValues, getTopicMappings, listAppUsers } from "@/lib/analytics/queries";
import { hasAdminCredentials } from "@/lib/supabase/admin";
import { ACTIVE_JOB_STATUSES } from "@/lib/imports/types";
import { pickString } from "@/lib/search-params";
import { fmtDateTime, fmtInt } from "@/lib/format";

export const metadata: Metadata = { title: "Settings & Imports" };

/** Server actions on this page start background work (import validation) after responding. */
export const maxDuration = 60;

const TABS = ["projects", "imports", "categories", "thresholds", "preferences", "access", "audit"] as const;
type Tab = (typeof TABS)[number];

export default function SettingsPage({ searchParams }: PageProps<"/settings">) {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5">
      <PageHeader
        title="Settings & Imports"
        description="Manage projects and reporting cycles, import new exports, map topics to categories, and configure thresholds and access."
      />
      <Suspense fallback={<PageSkeleton />}>
        <SettingsContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function SettingsContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireViewer();
  const isAdmin = viewer.role === "admin";
  const sp = await searchParams;
  const requested = pickString(sp, "tab", 20) as Tab | undefined;
  const tab: Tab = requested && TABS.includes(requested) && (isAdmin || (requested !== "access" && requested !== "audit")) ? requested : "projects";
  const preselect = pickString(sp, "project", 40);
  const historyFilter = pickString(sp, "history", 40);

  const [settings, runs, jobs, mappings, statuses, users, audit] = await Promise.all([
    getSettings(),
    getImportRuns(200),
    isAdmin ? getImportJobs(100) : Promise.resolve([]),
    getTopicMappings(),
    getStatusValues(),
    isAdmin ? listAppUsers() : Promise.resolve([]),
    isAdmin ? getAuditEvents(200) : Promise.resolve([]),
  ]);

  const unmapped = mappings.topics.filter((t) => !t.mapped && t.tickets > 0).length + statuses.filter((s) => !s.configured && s.tickets > 0).length;
  const activeJobs = jobs.filter((j) => ACTIVE_JOB_STATUSES.includes(j.status) && j.status !== "awaiting_upload");
  const recentJobs = jobs.filter((j) => !j.import_run_id && (j.status === "failed" || j.status === "cancelled")).slice(0, 10);
  const shownRuns = historyFilter ? runs.filter((r) => r.project === historyFilter) : runs;

  return (
    <Tabs defaultValue={tab} className="gap-4">
      {/* One scrollable row on narrow screens (wrapping would overflow the fixed-height list). */}
      <TabsList className="max-w-full justify-start overflow-x-auto">
        <TabsTrigger value="projects">Projects</TabsTrigger>
        <TabsTrigger value="imports" className="gap-1.5">
          Imports
          {activeJobs.length > 0 && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {activeJobs.length}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="categories" className="gap-1.5">
          Categories
          {unmapped > 0 && (
            <Badge variant="outline" className="h-4 border-amber-500/50 px-1.5 text-[10px] text-amber-800 dark:text-amber-300">
              {unmapped}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="thresholds">Thresholds</TabsTrigger>
        <TabsTrigger value="preferences">Preferences</TabsTrigger>
        <TabsTrigger value="access" disabled={!isAdmin}>
          {!isAdmin && <Lock className="size-3" />} Access
        </TabsTrigger>
        <TabsTrigger value="audit" disabled={!isAdmin}>
          {!isAdmin && <Lock className="size-3" />} Audit log
        </TabsTrigger>
      </TabsList>

      {!isAdmin && <p className="text-xs text-muted-foreground">You have the analyst role: settings are read-only, and imports are performed by administrators.</p>}

      <TabsContent value="projects">
        <ProjectsPanel cycles={settings.cycles} projects={settings.projects} isAdmin={isAdmin} />
      </TabsContent>

      <TabsContent value="imports" className="flex flex-col gap-4">
        {isAdmin && (
          <>
            {!hasAdminCredentials() && (
              <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
                Uploads are disabled: the server has no SUPABASE_SECRET_KEY to issue signed upload URLs.
              </p>
            )}
            <TemplateCard projects={settings.projects} initialProject={preselect} />
            <ImportWizard projects={settings.projects} cycles={settings.cycles} initialProject={preselect} />
          </>
        )}

        {isAdmin && (activeJobs.length > 0 || recentJobs.length > 0) && (
          <Card className="shadow-xs">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Imports in progress and recent attempts</CardTitle>
              <CardDescription className="text-xs">Jobs continue in the background and survive closing the browser. Open one to review, confirm or retry.</CardDescription>
            </CardHeader>
            <CardContent className="px-0 sm:px-6">
              <div className="overflow-x-auto sm:rounded-lg sm:border">
                <Table className="text-xs">
                  <TableHeader className="bg-muted/40">
                    <TableRow>
                      <TableHead>Created</TableHead>
                      <TableHead>File</TableHead>
                      <TableHead>Project</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-48">Progress</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...activeJobs, ...recentJobs].map((j) => {
                      const pct = j.status === "importing" && j.rows_to_apply ? Math.round((j.rows_applied / j.rows_to_apply) * 100) : j.status === "ready" ? 100 : null;
                      return (
                        <TableRow key={j.id}>
                          <TableCell className="tabular whitespace-nowrap">{fmtDateTime(j.created_at)}</TableCell>
                          <TableCell className="max-w-64 truncate" title={j.original_filename}>
                            {j.original_filename}
                          </TableCell>
                          <TableCell>
                            {j.project ?? "—"}
                            {j.mode === "archive_and_start" && <span className="block text-[11px] text-muted-foreground">archives {j.archive_project ?? j.archive_cycle}</span>}
                          </TableCell>
                          <TableCell>
                            <JobStatusBadge status={j.status} stalled={j.stalled} />
                          </TableCell>
                          <TableCell>
                            {pct !== null ? (
                              <div className="flex items-center gap-2">
                                <Progress value={pct} className="h-1.5" />
                                <span className="tabular text-muted-foreground">{pct}%</span>
                              </div>
                            ) : j.status === "failed" ? (
                              <span className="line-clamp-2 text-destructive" title={j.last_error ?? ""}>
                                {j.last_error}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">{j.rows_staged ? `${fmtInt(j.rows_staged)} rows read` : "—"}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Link href={`/settings/imports/jobs/${j.id}`} className="font-medium text-primary hover:underline">
                              {j.status === "ready" ? "Review" : "Open"}
                            </Link>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="shadow-xs">
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="text-sm font-semibold">Import history</CardTitle>
              <CardDescription className="text-xs">Every import applied to the database (web and command line), newest first.</CardDescription>
            </div>
            {historyFilter && (
              <Link href="/settings?tab=imports" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted">
                Project {historyFilter} <X className="size-3" />
              </Link>
            )}
          </CardHeader>
          <CardContent className="px-0 sm:px-6">
            <div className="overflow-x-auto sm:rounded-lg sm:border">
              <Table className="text-xs">
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>File</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="text-right">Inserted</TableHead>
                    <TableHead className="text-right">Updated</TableHead>
                    <TableHead className="text-right">Unchanged</TableHead>
                    <TableHead className="text-right">Older</TableHead>
                    <TableHead className="text-right">Rejected</TableHead>
                    <TableHead>Report</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shownRuns.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={12} className="py-8 text-center text-muted-foreground">
                        No imports yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {shownRuns.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="tabular whitespace-nowrap">{fmtDateTime(r.started_at)}</TableCell>
                      <TableCell>{r.source === "web" ? "Web" : "CLI"}</TableCell>
                      <TableCell className="max-w-64 truncate" title={r.source_filename}>
                        {r.source_filename}
                      </TableCell>
                      <TableCell>
                        {r.project ?? "—"}
                        {r.project_status === "archived" && <span className="ml-1 text-[11px] text-muted-foreground">(archived)</span>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.status === "completed" ? "secondary" : r.status === "failed" ? "destructive" : "outline"} className="font-normal">
                          {r.status.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular text-right">{fmtInt(r.records_in_file)}</TableCell>
                      <TableCell className="tabular text-right">{fmtInt(r.inserted_count)}</TableCell>
                      <TableCell className="tabular text-right">{fmtInt(r.updated_count)}</TableCell>
                      <TableCell className="tabular text-right">{fmtInt(r.skipped_unchanged_count)}</TableCell>
                      <TableCell className="tabular text-right">{fmtInt(r.skipped_stale_count)}</TableCell>
                      <TableCell className="tabular text-right">{fmtInt(r.rejected_count)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Link href={`/settings/imports/${r.id}`} className="font-medium hover:underline">
                          Run
                        </Link>
                        {isAdmin && r.job_id && (
                          <>
                            {" · "}
                            <Link href={`/settings/imports/jobs/${r.job_id}`} className="font-medium hover:underline">
                              Job
                            </Link>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="categories">
        <CategoriesPanel mappings={mappings} statuses={statuses} isAdmin={isAdmin} />
      </TabsContent>

      <TabsContent value="thresholds" className="flex flex-col gap-4">
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Analytics thresholds</CardTitle>
            <CardDescription className="text-xs">
              Illustrative monitoring thresholds used for breach counts across the dashboard. They are not contractual SLAs and no SLA data exists in the exports.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ThresholdForm thresholds={settings.thresholds} disabled={!isAdmin} />
          </CardContent>
        </Card>
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Insights &amp; Recommendations rules</CardTitle>
            <CardDescription className="text-xs">
              When an observation is reported on the Insights page. Changes apply on the next page load; insights are always recomputed from the current data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <InsightRulesForm rules={settings.insight_rules} disabled={!isAdmin} />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="preferences">
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Application preferences</CardTitle>
          </CardHeader>
          <CardContent>
            <PreferencesForm app={settings.app} disabled={!isAdmin} />
          </CardContent>
        </Card>
      </TabsContent>

      {isAdmin && (
        <TabsContent value="access">
          <Card className="shadow-xs">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Access management</CardTitle>
              <CardDescription className="text-xs">Roles are enforced in PostgreSQL. At least one administrator must always remain.</CardDescription>
            </CardHeader>
            <CardContent>
              <AccessManager users={users} currentUserId={viewer.userId} canInvite={hasAdminCredentials()} />
            </CardContent>
          </Card>
        </TabsContent>
      )}

      {isAdmin && (
        <TabsContent value="audit">
          <Card className="shadow-xs">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Audit log</CardTitle>
              <CardDescription className="text-xs">Imports, project and cycle changes, mappings, exports, content views, settings and access changes (latest 200).</CardDescription>
            </CardHeader>
            <CardContent>
              <DataTable
                maxHeight={560}
                table={{
                  columns: [
                    { key: "when", label: "When" },
                    { key: "who", label: "User" },
                    { key: "action", label: "Action" },
                    { key: "details", label: "Details" },
                  ],
                  rows: audit.map((a) => ({ when: fmtDateTime(a.occurred_at), who: a.email ?? "system / CLI", action: a.action, details: JSON.stringify(a.details).slice(0, 240) })),
                }}
              />
            </CardContent>
          </Card>
        </TabsContent>
      )}
    </Tabs>
  );
}
