"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { Archive, ChevronDown, FolderPlus, History, Loader2, MoreHorizontal, Pencil, Plus, RotateCcw, Star, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { LifecycleBadge } from "./status-badges";
import {
  archiveCycle,
  archiveProject,
  createCycle,
  createProject,
  restoreCycle,
  restoreProject,
  saveProject,
  setCurrentCycle,
  type ActionResult,
} from "@/lib/settings/actions";
import type { ReportingCycle, SettingsProject } from "@/lib/analytics/types";
import { fmtDate, fmtDateTime, fmtInt } from "@/lib/format";

/** Form action that reports its result as a toast and runs onOk after success (no effects involved). */
function useFormAction(fn: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>, onOk?: () => void) {
  return useActionState<ActionResult | null, FormData>(async (prev, fd) => {
    const r = await fn(prev, fd);
    if (r.ok) {
      toast.success(r.message);
      onOk?.();
    } else toast.error(r.message);
    return r;
  }, null);
}

function runAction(start: (cb: () => Promise<void>) => void, fn: () => Promise<ActionResult>, onOk?: () => void) {
  start(async () => {
    const r = await fn();
    if (r.ok) {
      toast.success(r.message);
      onOk?.();
    } else toast.error(r.message);
  });
}

/** Suggests a project code from its name: "DECI — 5th Intake" → "DECI_5TH_INTAKE". */
export function suggestCode(name: string): string {
  const c = name
    .toUpperCase()
    .normalize("NFKD")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^A-Z]+/, "")
    .slice(0, 40);
  return c;
}

export function ProjectsPanel({ cycles, projects, isAdmin }: { cycles: ReportingCycle[]; projects: SettingsProject[]; isAdmin: boolean }) {
  const current = cycles.find((c) => c.is_current) ?? null;
  const activeCycles = cycles.filter((c) => c.status === "active");
  const archivedCycles = cycles.filter((c) => c.status === "archived");
  const programs = [...new Set(projects.map((p) => p.program))].sort();
  const live = projects.filter((p) => p.status !== "archived" && p.cycle_status !== "archived");
  const archived = projects.filter((p) => p.status === "archived" || p.cycle_status === "archived");

  return (
    <div className="flex flex-col gap-4">
      <Card className="shadow-xs">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-sm font-semibold">Current reporting cycle</CardTitle>
            <CardDescription className="text-xs">
              The dashboard shows the current cycle by default. Archived cycles stay available as history but are never combined with it.
            </CardDescription>
          </div>
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              <CreateCycleDialog />
              {activeCycles.length > 1 && <ChangeCurrentDialog cycles={activeCycles} current={current} />}
              {current && <ArchiveCycleDialog cycle={current} others={activeCycles.filter((c) => c.code !== current.code)} projects={live.filter((p) => p.cycle === current.code)} />}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {current ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span className="font-semibold">{current.name}</span>
              <code className="rounded bg-muted px-1.5 text-xs">{current.code}</code>
              <span className="text-muted-foreground">{current.projects} project(s)</span>
              {current.description && <span className="text-xs text-muted-foreground">{current.description}</span>}
            </div>
          ) : (
            <p className="text-sm text-amber-700 dark:text-amber-400">No cycle is current — the dashboard is empty until one is selected.</p>
          )}
          {activeCycles.filter((c) => !c.is_current).length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Other active cycles: {activeCycles.filter((c) => !c.is_current).map((c) => `${c.name} (${c.code})`).join(", ")}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-xs">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-sm font-semibold">Projects</CardTitle>
            <CardDescription className="text-xs">
              Each project maps one Organization_ID to an intake. Create a project, then import its export in the Imports tab.
            </CardDescription>
          </div>
          {isAdmin && <ProjectDialog mode="create" cycles={activeCycles} programs={programs} defaultCycle={current?.code} />}
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          <ProjectTable projects={live} isAdmin={isAdmin} cycles={activeCycles} programs={programs} />
        </CardContent>
      </Card>

      {(archived.length > 0 || archivedCycles.length > 0) && (
        <Collapsible>
          <Card className="shadow-xs">
            <CardHeader>
              <CollapsibleTrigger asChild>
                <button type="button" className="group flex w-full items-center justify-between text-left">
                  <span>
                    <CardTitle className="text-sm font-semibold">Archive</CardTitle>
                    <CardDescription className="text-xs">
                      {archived.length} archived project(s) · {archivedCycles.length} archived cycle(s). Data is preserved and visible through the cycle selector&apos;s history view.
                    </CardDescription>
                  </span>
                  <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                </button>
              </CollapsibleTrigger>
            </CardHeader>
            <CollapsibleContent>
              <CardContent className="flex flex-col gap-4 px-0 sm:px-6">
                {archivedCycles.length > 0 && (
                  <div className="overflow-x-auto rounded-lg border">
                    <Table className="text-xs">
                      <TableHeader className="bg-muted/40">
                        <TableRow>
                          <TableHead>Cycle</TableHead>
                          <TableHead>Archived</TableHead>
                          <TableHead>Reason</TableHead>
                          <TableHead className="text-right">Projects</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {archivedCycles.map((c) => (
                          <TableRow key={c.code}>
                            <TableCell>
                              <p className="font-medium">{c.name}</p>
                              <code className="text-[11px] text-muted-foreground">{c.code}</code>
                            </TableCell>
                            <TableCell className="tabular">{fmtDate(c.archived_at)}</TableCell>
                            <TableCell className="max-w-64 truncate" title={c.archive_reason ?? ""}>
                              {c.archive_reason ?? "—"}
                            </TableCell>
                            <TableCell className="tabular text-right">{c.projects}</TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button asChild variant="ghost" size="sm" className="h-7">
                                  <Link href={`/overview?cycle=${c.code}`}>
                                    <History /> View
                                  </Link>
                                </Button>
                                {isAdmin && <RestoreCycleButton cycle={c} />}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {archived.length > 0 && <ProjectTable projects={archived} isAdmin={isAdmin} cycles={activeCycles} programs={programs} archivedView />}
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}
    </div>
  );
}

function ProjectTable({
  projects,
  isAdmin,
  cycles,
  programs,
  archivedView = false,
}: {
  projects: SettingsProject[];
  isAdmin: boolean;
  cycles: ReportingCycle[];
  programs: string[];
  archivedView?: boolean;
}) {
  if (projects.length === 0) {
    return <p className="px-6 py-6 text-center text-sm text-muted-foreground sm:px-0">No projects yet.</p>;
  }
  return (
    <div className="overflow-x-auto sm:rounded-lg sm:border">
      <Table className="text-xs">
        <TableHeader className="bg-muted/40">
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Cycle</TableHead>
            <TableHead className="text-right">Org ID</TableHead>
            <TableHead className="text-right">Tickets</TableHead>
            <TableHead>Last successful import</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((p) => (
            <TableRow key={p.code}>
              <TableCell>
                <p className="font-medium">{p.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  <code>{p.code}</code> · {p.program} · {p.intake}
                </p>
              </TableCell>
              <TableCell className="text-muted-foreground">{p.cycle_name}</TableCell>
              <TableCell className="tabular text-right">{p.organization_id}</TableCell>
              <TableCell className="tabular text-right">{fmtInt(p.tickets)}</TableCell>
              <TableCell>
                {p.last_import ? (
                  <div>
                    <p className="tabular">{fmtDateTime(p.last_import.completed_at)}</p>
                    <p className="text-[11px] text-muted-foreground">data as of {fmtDateTime(p.snapshot_at)} · {p.last_import.source === "web" ? "web" : "CLI"}</p>
                  </div>
                ) : (
                  <span className="text-muted-foreground">Never</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <LifecycleBadge status={p.status === "active" && p.cycle_status === "archived" ? "archived" : p.status} />
                  {p.active_job && (
                    <Link href={`/settings/imports/jobs/${p.active_job.id}`} className="text-[11px] text-primary hover:underline">
                      Import {p.active_job.status.replace(/_/g, " ")}
                    </Link>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right">
                <ProjectActions project={p} isAdmin={isAdmin} cycles={cycles} programs={programs} archivedView={archivedView} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ProjectActions({
  project,
  isAdmin,
  cycles,
  programs,
  archivedView,
}: {
  project: SettingsProject;
  isAdmin: boolean;
  cycles: ReportingCycle[];
  programs: string[];
  archivedView: boolean;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const history = `/settings?tab=imports&history=${project.code}`;
  const viewHref = project.status === "archived" ? `/projects/${project.code}?cycle=${project.cycle}&archived=1` : `/projects/${project.code}?cycle=${project.cycle}`;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label={`Actions for ${project.code}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={viewHref}>
              <History /> View analytics
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={history}>
              <History /> Import history ({project.imports})
            </Link>
          </DropdownMenuItem>
          {isAdmin && !archivedView && project.status === "active" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href={`/settings?tab=imports&project=${project.code}`}>
                  <Upload /> Import data
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                <Pencil /> Edit details
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setArchiveOpen(true)} className="text-destructive">
                <Archive /> Archive…
              </DropdownMenuItem>
            </>
          )}
          {isAdmin && project.status === "archived" && project.cycle_status === "active" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setRestoreOpen(true)}>
                <RotateCcw /> Restore…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {isAdmin && (
        <>
          <ProjectDialog mode="edit" project={project} cycles={cycles} programs={programs} open={editOpen} onOpenChange={setEditOpen} />
          <ArchiveProjectDialog project={project} open={archiveOpen} onOpenChange={setArchiveOpen} />
          <RestoreProjectDialog project={project} open={restoreOpen} onOpenChange={setRestoreOpen} />
        </>
      )}
    </>
  );
}

export function ProjectFields({
  project,
  programs,
  cycles,
  defaultCycle,
  prefix = "",
  lockCode = false,
  hasTickets = false,
}: {
  project?: Partial<SettingsProject>;
  programs: string[];
  cycles?: ReportingCycle[];
  defaultCycle?: string;
  prefix?: string;
  lockCode?: boolean;
  hasTickets?: boolean;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [code, setCode] = useState(project?.code ?? "");
  const [codeTouched, setCodeTouched] = useState(Boolean(project?.code));
  const id = (k: string) => `${prefix}${k}`;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={id("name")}>Project name</Label>
        <Input
          id={id("name")}
          name="name"
          required
          maxLength={120}
          placeholder="DECI — 5th Intake"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!codeTouched && !lockCode) setCode(suggestCode(e.target.value));
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={id("code")}>Project code</Label>
        <Input
          id={id("code")}
          name="code"
          required
          readOnly={lockCode}
          maxLength={40}
          pattern="[A-Za-z][A-Za-z0-9_]{1,39}"
          className="font-mono uppercase"
          value={code}
          onChange={(e) => {
            setCodeTouched(true);
            setCode(e.target.value.toUpperCase());
          }}
        />
        <p className="text-[11px] text-muted-foreground">{lockCode ? "Codes are permanent (used in links and history)." : "Permanent identifier, e.g. DECI_5TH."}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={id("program")}>Program</Label>
        <Input id={id("program")} name="program" required maxLength={20} list={id("programs")} className="uppercase" defaultValue={project?.program ?? ""} placeholder="DECI, DEMI or a new program" />
        <datalist id={id("programs")}>
          {programs.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={id("intake")}>Intake</Label>
        <Input id={id("intake")} name="intake" required maxLength={60} defaultValue={project?.intake ?? ""} placeholder="5th Intake" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={id("organization_id")}>Organization ID</Label>
        <Input
          id={id("organization_id")}
          name="organization_id"
          required
          inputMode="numeric"
          pattern="[1-9][0-9]{0,8}"
          defaultValue={project?.organization_id ?? ""}
          readOnly={hasTickets}
          className="tabular"
        />
        <p className="text-[11px] text-muted-foreground">
          {hasTickets ? "Fixed once tickets are imported." : "The Organization_ID used in this project's exports."}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={id("intake_group")}>Intake group (optional)</Label>
        <Input id={id("intake_group")} name="intake_group" maxLength={40} defaultValue={project?.intake_group ?? ""} placeholder="Regular / Summer / …" />
      </div>
      {cycles && !lockCode && (
        <div className="space-y-1.5">
          <Label>Reporting cycle</Label>
          <Select name="cycle" defaultValue={defaultCycle ?? cycles[0]?.code}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {cycles.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.name}
                  {c.is_current ? " (current)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={id("description")}>Description (optional)</Label>
        <Textarea id={id("description")} name="description" maxLength={1000} rows={2} defaultValue={project?.description ?? ""} />
      </div>
    </div>
  );
}

function ProjectDialog({
  mode,
  project,
  cycles,
  programs,
  defaultCycle,
  open: controlledOpen,
  onOpenChange,
}: {
  mode: "create" | "edit";
  project?: SettingsProject;
  cycles: ReportingCycle[];
  programs: string[];
  defaultCycle?: string;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  const setOpen = onOpenChange ?? setInnerOpen;
  const [, action, pending] = useFormAction(mode === "create" ? createProject : saveProject, () => setOpen(false));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {mode === "create" && (
        <DialogTrigger asChild>
          <Button size="sm">
            <FolderPlus /> Create project
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Create project" : `Edit ${project?.code}`}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "The project starts empty. Import its export from the Imports tab; the file's Organization_ID must match."
              : "Changes apply everywhere immediately. The code cannot change."}
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <ProjectFields
            project={project}
            programs={programs}
            cycles={mode === "create" ? cycles : undefined}
            defaultCycle={defaultCycle}
            prefix={`${mode}-${project?.code ?? "new"}-`}
            lockCode={mode === "edit"}
            hasTickets={(project?.tickets ?? 0) > 0}
          />
          {mode === "edit" && <input type="hidden" name="display_order" value={project?.display_order ?? ""} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} {mode === "create" ? "Create project" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveProjectDialog({ project, open, onOpenChange }: { project: SettingsProject; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive {project.name}?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>Archiving is not deletion. What happens:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>All {fmtInt(project.tickets)} tickets and the full import history are kept unchanged.</li>
                <li>The project disappears from the default dashboard and no new data can be imported into it.</li>
                <li>It stays available in the history view (cycle selector → include archived projects).</li>
                <li>Organization ID {project.organization_id} becomes free for a new project. You can restore the project later.</li>
              </ul>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`reason-${project.code}`}>Reason (recorded in the audit log)</Label>
            <Input id={`reason-${project.code}`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Intake finished" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`confirm-${project.code}`}>
              Type <code className="rounded bg-muted px-1">{project.code}</code> to confirm
            </Label>
            <Input id={`confirm-${project.code}`} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" className="font-mono" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending || confirm !== project.code}
            onClick={() => runAction(start, () => archiveProject(project.code, reason, confirm), () => onOpenChange(false))}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Archive />} Archive project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestoreProjectDialog({ project, open, onOpenChange }: { project: SettingsProject; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore {project.name}?</DialogTitle>
          <DialogDescription>
            The project returns to the active dashboard of {project.cycle_name} with its {fmtInt(project.tickets)} tickets, and imports into it are allowed again. This is
            refused while another active project uses Organization ID {project.organization_id}.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={() => runAction(start, () => restoreProject(project.code), () => onOpenChange(false))}>
            {pending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Restore project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateCycleDialog() {
  const [open, setOpen] = useState(false);
  const [, action, pending] = useFormAction(createCycle, () => setOpen(false));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> New cycle
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create reporting cycle</DialogTitle>
          <DialogDescription>
            A cycle groups the projects that are analysed together (e.g. one academic year). To replace the current cycle with a fresh dataset in one step, use
            Imports → &quot;Archive &amp; start new&quot;.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cycle-name">Name</Label>
            <Input id="cycle-name" name="name" required maxLength={120} placeholder="2027 reporting cycle" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cycle-code">Code</Label>
            <Input id="cycle-code" name="code" required maxLength={40} className="font-mono uppercase" placeholder="CYCLE_2027" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cycle-description">Description (optional)</Label>
            <Textarea id="cycle-description" name="description" rows={2} maxLength={1000} />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="cycle-current" name="make_current" />
            <Label htmlFor="cycle-current" className="font-normal">
              Make it the current cycle now (the dashboard switches to it)
            </Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Create cycle
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChangeCurrentDialog({ cycles, current }: { cycles: ReportingCycle[]; current: ReportingCycle | null }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(current?.code ?? cycles[0]?.code ?? "");
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Star /> Change current
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Select the current reporting cycle</DialogTitle>
          <DialogDescription>Every user&apos;s dashboard opens on the current cycle. Other cycles remain available from the cycle selector.</DialogDescription>
        </DialogHeader>
        <Select value={code} onValueChange={setCode}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {cycles.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.name} ({c.code})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={pending || code === current?.code} onClick={() => runAction(start, () => setCurrentCycle(code), () => setOpen(false))}>
            {pending && <Loader2 className="animate-spin" />} Make current
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveCycleDialog({ cycle, others, projects }: { cycle: ReportingCycle; others: ReportingCycle[]; projects: SettingsProject[] }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [next, setNext] = useState<string>(others[0]?.code ?? "__none__");
  const [pending, start] = useTransition();
  const tickets = projects.reduce((a, p) => a + p.tickets, 0);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="text-destructive">
          <Archive /> Archive cycle…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive the whole cycle {cycle.name}?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                {projects.length} active project(s) with {fmtInt(tickets)} tickets will be archived together. Nothing is deleted; the cycle stays available as history and can be
                restored.
              </p>
              <p>To archive and load a fresh dataset in one safe step, use Imports → &quot;Archive &amp; start new&quot; instead.</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Dashboard afterwards shows</Label>
            <Select value={next} onValueChange={setNext}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {others.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.name}
                  </SelectItem>
                ))}
                <SelectItem value="__none__">No current cycle (empty dashboard)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cycle-reason">Reason</Label>
            <Input id="cycle-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cycle-confirm">
              Type <code className="rounded bg-muted px-1">{cycle.code}</code> to confirm
            </Label>
            <Input id="cycle-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" className="font-mono" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending || confirm !== cycle.code}
            onClick={() => runAction(start, () => archiveCycle(cycle.code, reason, confirm, next === "__none__" ? null : next), () => setOpen(false))}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Archive />} Archive cycle
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestoreCycleButton({ cycle }: { cycle: ReportingCycle }) {
  const [open, setOpen] = useState(false);
  const [makeCurrent, setMakeCurrent] = useState(false);
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7">
          <RotateCcw /> Restore
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore {cycle.name}?</DialogTitle>
          <DialogDescription>
            The cycle and the projects archived together with it become active again (projects archived individually stay archived). Refused if one of their Organization IDs is in use by
            another active project.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Checkbox id={`restore-current-${cycle.code}`} checked={makeCurrent} onCheckedChange={(v) => setMakeCurrent(v === true)} />
          <Label htmlFor={`restore-current-${cycle.code}`} className="font-normal">
            Also make it the current cycle
          </Label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={() => runAction(start, () => restoreCycle(cycle.code, makeCurrent), () => setOpen(false))}>
            {pending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Restore cycle
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

