"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Archive, CheckCircle2, Download, FileSpreadsheet, FileUp, Loader2, RefreshCw, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { completeUpload, startImport, type StartImportInput } from "@/lib/imports/actions";
import { MAX_IMPORT_BYTES } from "@/lib/imports/constants";
import type { ReportingCycle, SettingsProject } from "@/lib/analytics/types";
import { fmtInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fmtBytes } from "./job-monitor";
import { suggestCode } from "./projects-panel";

export function TemplateCard({ projects, initialProject }: { projects: SettingsProject[]; initialProject?: string }) {
  const active = projects.filter((p) => p.status === "active");
  const [project, setProject] = useState<string>(initialProject && active.some((p) => p.code === initialProject) ? initialProject : "__any__");
  const q = project === "__any__" ? "" : `&project=${encodeURIComponent(project)}`;
  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <FileSpreadsheet className="size-4" /> Import template
        </CardTitle>
        <CardDescription className="text-xs">
          The 19 columns of the original ticket export, in the original order. The Excel template adds an Instructions sheet, valid examples on a separate sheet (never imported),
          text-formatted ID columns and a status list.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label>For project (optional)</Label>
          <Select value={project} onValueChange={setProject}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">Generic template</SelectItem>
              {active.map((p) => (
                <SelectItem key={p.code} value={p.code}>
                  {p.name} · Org {p.organization_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <a href={`/api/imports/template?format=xlsx${q}`} download>
              <Download /> Excel template (.xlsx)
            </a>
          </Button>
          <Button asChild variant="outline">
            <a href={`/api/imports/template?format=csv${q}`} download>
              <Download /> CSV template (.csv)
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

type Mode = "upsert" | "archive_and_start";
type Phase = { kind: "idle" } | { kind: "preparing" } | { kind: "uploading"; pct: number; jobId: string } | { kind: "finishing"; jobId: string } | { kind: "error"; message: string; retry?: () => void };

interface NewProject {
  code: string;
  name: string;
  program: string;
  intake: string;
  organization_id: string;
  description: string;
}

/** PUT the file straight to the signed Storage URL (never through this app's server), reporting progress. */
function uploadWithProgress(url: string, file: File, contentType: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", contentType);
    xhr.setRequestHeader("x-upsert", "false");
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (key) xhr.setRequestHeader("apikey", key);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      // 409 = the object already exists (a previous attempt completed): fine.
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 409) resolve();
      else reject(new Error(`Upload failed (HTTP ${xhr.status}). ${xhr.responseText.slice(0, 200)}`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload. Check the connection and retry."));
    xhr.ontimeout = () => reject(new Error("The upload timed out. Retry."));
    xhr.timeout = 30 * 60 * 1000;
    xhr.send(file);
  });
}

export function ImportWizard({ projects, cycles, initialProject }: { projects: SettingsProject[]; cycles: ReportingCycle[]; initialProject?: string }) {
  const router = useRouter();
  const active = projects.filter((p) => p.status === "active" && p.cycle_status === "active");
  const current = cycles.find((c) => c.is_current);
  const activeCycles = cycles.filter((c) => c.status === "active");
  const programs = [...new Set(projects.map((p) => p.program))].sort();

  const [mode, setMode] = useState<Mode>("upsert");
  const [project, setProject] = useState(initialProject && active.some((p) => p.code === initialProject) ? initialProject : (active[0]?.code ?? ""));
  const [scope, setScope] = useState<"project" | "cycle">("project");
  const [archiveProject, setArchiveProject] = useState(active[0]?.code ?? "");
  const [archiveCycle, setArchiveCycle] = useState(current?.code ?? activeCycles[0]?.code ?? "");
  const [np, setNp] = useState<NewProject>({ code: "", name: "", program: "", intake: "", organization_id: "", description: "" });
  const [codeTouched, setCodeTouched] = useState(false);
  const [nc, setNc] = useState({ code: "", name: "", description: "" });
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const input = useRef<HTMLInputElement>(null);

  const archived = mode === "archive_and_start" && scope === "project" ? active.find((p) => p.code === archiveProject) : null;
  const busy = phase.kind === "preparing" || phase.kind === "uploading" || phase.kind === "finishing";

  const pickFile = (f: File | undefined | null) => {
    if (!f) return;
    const ext = f.name.toLowerCase().split(".").pop();
    if (ext !== "csv" && ext !== "xlsx") {
      toast.error("Choose a .csv or .xlsx file. Older .xls workbooks must be saved as .xlsx first.");
      return;
    }
    if (f.size === 0) {
      toast.error("The file is empty.");
      return;
    }
    if (f.size > MAX_IMPORT_BYTES) {
      toast.error(`The file is ${(f.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB. Split the export (e.g. by month).`);
      return;
    }
    setFile(f);
    setPhase({ kind: "idle" });
  };

  const prefillFromArchived = (code: string) => {
    const p = active.find((x) => x.code === code);
    if (!p) return;
    setNp((cur) => ({ ...cur, program: cur.program || p.program, organization_id: cur.organization_id || String(p.organization_id) }));
  };

  const submit = async () => {
    if (!file) return;
    let spec: StartImportInput;
    if (mode === "upsert") {
      spec = { mode, project_code: project, filename: file.name, size_bytes: file.size };
    } else {
      spec = {
        mode,
        archive_scope: scope,
        archive_project_code: scope === "project" ? archiveProject : undefined,
        archive_cycle_code: scope === "cycle" ? archiveCycle : undefined,
        new_project: {
          code: np.code,
          name: np.name,
          program: np.program,
          intake: np.intake,
          organization_id: Number(np.organization_id),
          description: np.description || undefined,
        },
        new_cycle: scope === "cycle" ? { code: nc.code, name: nc.name, description: nc.description || undefined } : undefined,
        filename: file.name,
        size_bytes: file.size,
      };
    }
    setPhase({ kind: "preparing" });
    const started = await startImport(spec);
    if (!started.ok || !started.data) {
      setPhase({ kind: "error", message: started.message });
      return;
    }
    const { jobId, signedUrl, contentType } = started.data;
    const doUpload = async () => {
      try {
        setPhase({ kind: "uploading", pct: 0, jobId });
        await uploadWithProgress(signedUrl, file, contentType, (pct) => setPhase({ kind: "uploading", pct, jobId }));
        setPhase({ kind: "finishing", jobId });
        const done = await completeUpload(jobId);
        if (!done.ok) throw new Error(done.message);
        toast.success("Uploaded. Validation is running in the background.");
        router.push(`/settings/imports/jobs/${jobId}`);
      } catch (err) {
        setPhase({ kind: "error", message: (err as Error).message, retry: doUpload });
      }
    };
    await doUpload();
  };

  const canSubmit =
    Boolean(file) &&
    !busy &&
    (mode === "upsert"
      ? Boolean(project)
      : Boolean(np.code && np.name && np.program && np.intake && /^[1-9]\d{0,8}$/.test(np.organization_id)) &&
        (scope === "project" ? Boolean(archiveProject) : Boolean(archiveCycle && nc.code && nc.name)));

  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Upload className="size-4" /> New import
        </CardTitle>
        <CardDescription className="text-xs">
          The file goes straight to private storage, is validated in the background, and nothing is written until you review the preview and confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">1 · Import mode</h3>
          <div className="grid gap-3 md:grid-cols-2" role="radiogroup" aria-label="Import mode">
            <ModeCard
              selected={mode === "upsert"}
              onSelect={() => setMode("upsert")}
              icon={RefreshCw}
              title="Add / update an existing project"
              text="New tickets are added, changed tickets updated (with history). Tickets missing from the file are kept. Older exports never overwrite newer data."
            />
            <ModeCard
              selected={mode === "archive_and_start"}
              onSelect={() => setMode("archive_and_start")}
              icon={Archive}
              title="Archive & start new"
              text="Archive a project or a whole reporting cycle and load this file into a fresh project. The switch happens only when the import has fully succeeded."
            />
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">2 · {mode === "upsert" ? "Target project" : "What to archive and the new project"}</h3>
          {mode === "upsert" ? (
            active.length === 0 ? (
              <p className="text-sm text-muted-foreground">There is no active project. Create one in the Projects tab first.</p>
            ) : (
              <div className="max-w-md space-y-1.5">
                <Label>Project</Label>
                <Select value={project} onValueChange={setProject}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {active.map((p) => (
                      <SelectItem key={p.code} value={p.code}>
                        {p.name} · Org {p.organization_id} · {fmtInt(p.tickets)} tickets
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Rows must carry this project&apos;s Organization_ID (empty values are filled in).</p>
              </div>
            )
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Archive scope">
                {(["project", "cycle"] as const).map((s) => (
                  <Button key={s} type="button" size="sm" variant={scope === s ? "default" : "outline"} role="radio" aria-checked={scope === s} onClick={() => setScope(s)}>
                    {s === "project" ? "Archive one project (single intake)" : "Archive a whole reporting cycle"}
                  </Button>
                ))}
              </div>
              {scope === "project" ? (
                <div className="max-w-md space-y-1.5">
                  <Label>Project to archive</Label>
                  <Select
                    value={archiveProject}
                    onValueChange={(v) => {
                      setArchiveProject(v);
                      prefillFromArchived(v);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {active.map((p) => (
                        <SelectItem key={p.code} value={p.code}>
                          {p.name} · {fmtInt(p.tickets)} tickets
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">The new project joins the same cycle ({archived?.cycle_name ?? "—"}).</p>
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label>Cycle to archive</Label>
                    <Select value={archiveCycle} onValueChange={setArchiveCycle}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {activeCycles.map((c) => (
                          <SelectItem key={c.code} value={c.code}>
                            {c.name} ({c.projects} projects)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="nc-name">New cycle name</Label>
                    <Input id="nc-name" value={nc.name} maxLength={120} placeholder="2027 reporting cycle" onChange={(e) => setNc({ ...nc, name: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="nc-code">New cycle code</Label>
                    <Input id="nc-code" value={nc.code} maxLength={40} className="font-mono uppercase" placeholder="CYCLE_2027" onChange={(e) => setNc({ ...nc, code: e.target.value.toUpperCase() })} />
                  </div>
                  <p className="text-xs text-muted-foreground md:col-span-3">
                    All active projects of the archived cycle are archived together; the new cycle becomes current. Add its other projects later and import them with
                    &quot;Add / update&quot;.
                  </p>
                </div>
              )}

              <div className="rounded-lg border p-3">
                <p className="mb-3 text-xs font-semibold">New project</p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="space-y-1.5 lg:col-span-2">
                    <Label htmlFor="np-name">Project name</Label>
                    <Input
                      id="np-name"
                      value={np.name}
                      maxLength={120}
                      placeholder="DECI — 5th Intake"
                      onChange={(e) => setNp({ ...np, name: e.target.value, code: codeTouched ? np.code : suggestCode(e.target.value) })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="np-code">Project code</Label>
                    <Input
                      id="np-code"
                      value={np.code}
                      maxLength={40}
                      className="font-mono uppercase"
                      onChange={(e) => {
                        setCodeTouched(true);
                        setNp({ ...np, code: e.target.value.toUpperCase() });
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="np-program">Program</Label>
                    <Input id="np-program" list="np-programs" value={np.program} maxLength={20} className="uppercase" placeholder="DECI" onChange={(e) => setNp({ ...np, program: e.target.value.toUpperCase() })} />
                    <datalist id="np-programs">
                      {programs.map((p) => (
                        <option key={p} value={p} />
                      ))}
                    </datalist>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="np-intake">Intake</Label>
                    <Input id="np-intake" value={np.intake} maxLength={60} placeholder="5th Intake" onChange={(e) => setNp({ ...np, intake: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="np-org">Organization ID</Label>
                    <Input id="np-org" value={np.organization_id} inputMode="numeric" className="tabular" onChange={(e) => setNp({ ...np, organization_id: e.target.value.replace(/\D/g, "") })} />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
                    <Label htmlFor="np-desc">Description (optional)</Label>
                    <Textarea id="np-desc" rows={2} maxLength={1000} value={np.description} onChange={(e) => setNp({ ...np, description: e.target.value })} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">3 · File</h3>
          <div
            role="button"
            tabIndex={0}
            onClick={() => !busy && input.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              if (!busy) pickFile(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors",
              drag ? "border-primary bg-primary/5" : "hover:bg-muted/40",
              busy && "cursor-not-allowed opacity-70",
            )}
          >
            <FileUp className="size-6 text-muted-foreground" aria-hidden />
            {file ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{file.name}</span>
                <span className="text-muted-foreground">{fmtBytes(file.size)}</span>
                {!busy && (
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-muted"
                    aria-label="Remove file"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                    }}
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            ) : (
              <>
                <p className="text-sm font-medium">Drop the export here, or click to choose</p>
                <p className="text-xs text-muted-foreground">.xlsx or .csv (UTF-8) · up to {MAX_IMPORT_BYTES / 1024 / 1024} MB</p>
              </>
            )}
            <input ref={input} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(e) => pickFile(e.target.files?.[0])} />
          </div>

          {phase.kind === "uploading" && (
            <div className="space-y-1.5" aria-live="polite">
              <div className="flex justify-between text-xs">
                <span>Uploading to private storage…</span>
                <span className="tabular">{phase.pct}%</span>
              </div>
              <Progress value={phase.pct} className="h-2" />
            </div>
          )}
          {phase.kind === "finishing" && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
              <CheckCircle2 className="size-3.5 text-emerald-600" /> Uploaded — starting validation…
            </p>
          )}
          {phase.kind === "error" && (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <span className="flex-1">{phase.message}</span>
              {phase.retry && (
                <Button size="sm" variant="outline" onClick={() => void phase.retry?.()}>
                  <RefreshCw /> Retry upload
                </Button>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {busy ? <Loader2 className="animate-spin" /> : <Upload />} Upload &amp; validate
            </Button>
            <p className="text-xs text-muted-foreground">Validation never changes data. You will see a preview before anything is imported.</p>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function ModeCard({ selected, onSelect, icon: Icon, title, text }: { selected: boolean; onSelect: () => void; icon: typeof Upload; title: string; text: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/40",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} aria-hidden />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{text}</span>
      </span>
    </button>
  );
}
