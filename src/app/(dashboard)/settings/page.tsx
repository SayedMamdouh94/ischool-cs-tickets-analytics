import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Lock, Terminal } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { DataTable } from "@/components/dashboard/data-table";
import { PageSkeleton } from "@/components/dashboard/states";
import { AccessManager, PreferencesForm, ProjectForm, ThresholdForm } from "@/components/settings/forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireViewer } from "@/lib/auth/dal";
import { getAuditEvents, getImportRuns, getSettings, listAppUsers } from "@/lib/analytics/queries";
import { hasAdminCredentials } from "@/lib/supabase/admin";
import { fmtDateTime, fmtInt } from "@/lib/format";

export const metadata: Metadata = { title: "Settings & Imports" };

export default function SettingsPage() {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5">
      <PageHeader title="Settings & Imports" description="Projects, analytics thresholds, preferences, import history and access management." />
      <Suspense fallback={<PageSkeleton />}>
        <SettingsContent />
      </Suspense>
    </div>
  );
}

async function SettingsContent() {
  const viewer = await requireViewer();
  const isAdmin = viewer.role === "admin";
  const [settings, runs, users, audit] = await Promise.all([
    getSettings(),
    getImportRuns(100),
    isAdmin ? listAppUsers() : Promise.resolve([]),
    isAdmin ? getAuditEvents(100) : Promise.resolve([]),
  ]);

  return (
    <Tabs defaultValue="thresholds" className="gap-4">
      <TabsList className="flex h-auto flex-wrap">
        <TabsTrigger value="thresholds">Thresholds</TabsTrigger>
        <TabsTrigger value="projects">Projects</TabsTrigger>
        <TabsTrigger value="imports">Imports</TabsTrigger>
        <TabsTrigger value="preferences">Preferences</TabsTrigger>
        <TabsTrigger value="access" disabled={!isAdmin}>
          {!isAdmin && <Lock className="size-3" />} Access
        </TabsTrigger>
        <TabsTrigger value="audit" disabled={!isAdmin}>
          {!isAdmin && <Lock className="size-3" />} Audit log
        </TabsTrigger>
      </TabsList>

      {!isAdmin && <p className="text-xs text-muted-foreground">You have the analyst role: settings are read-only.</p>}

      <TabsContent value="thresholds">
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
      </TabsContent>

      <TabsContent value="projects">
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Projects</CardTitle>
            <CardDescription className="text-xs">
              Program, intake and Organization_ID are fixed by migration (they define how exports are mapped). The filename hint is checked against each imported file.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {settings.projects.map((p) => (
              <ProjectForm key={p.code} project={p} disabled={!isAdmin} />
            ))}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="imports" className="space-y-4">
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Terminal className="size-4" /> Importing new exports
            </CardTitle>
            <CardDescription className="text-xs">
              Imports run from the admin command line (not through the web app), so multi-megabyte files never pass through a serverless function.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
              {`# place the CSV files in data/raw/, then:
npm run db:import -- --dry-run   # validate only
npm run db:import                # idempotent import
npm run db:validate              # reconcile database vs. files`}
            </pre>
          </CardContent>
        </Card>
        <div className="overflow-x-auto rounded-lg border">
          <Table className="text-xs">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="text-right">Inserted</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead className="text-right">Unchanged</TableHead>
                <TableHead className="text-right">Stale</TableHead>
                <TableHead className="text-right">Rejected</TableHead>
                <TableHead>Report</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="tabular whitespace-nowrap">{fmtDateTime(r.started_at)}</TableCell>
                  <TableCell className="max-w-64 truncate" title={r.source_filename}>
                    {r.source_filename}
                  </TableCell>
                  <TableCell>{r.project ?? "—"}</TableCell>
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
                  <TableCell>
                    <Link href={`/settings/imports/${r.id}`} className="font-medium hover:underline">
                      View
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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
              <CardDescription className="text-xs">Exports, content views, settings and access changes (latest 100).</CardDescription>
            </CardHeader>
            <CardContent>
              <DataTable
                maxHeight={520}
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
