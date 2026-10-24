"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Archive, Check, ChevronsUpDown, Database, History, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ScopeCycle } from "@/lib/analytics/types";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** List filters whose options depend on the scope; they are cleared when the cycle changes. */
const SCOPED_PARAMS = ["project", "program", "intake", "status", "topic", "responder", "resolver", "category", "theme", "session", "lesson", "ticket", "tproject", "page"];

/**
 * Global analytical scope: exactly one reporting cycle (default: the current
 * one). Archived projects are excluded unless explicitly included; archived
 * cycles are an intentional historical view. Cycles are never combined.
 */
export function ScopeSelector({ catalog }: { catalog: ScopeCycle[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const requested = params.get("cycle");
  const includeArchived = params.get("archived") === "1";
  const current = catalog.find((c) => c.is_current) ?? null;
  const selected = (requested ? catalog.find((c) => c.code === requested) : current) ?? null;
  const historical = selected?.status === "archived" || (includeArchived && selected?.projects.some((p) => p.status === "archived"));

  const go = (cycle: string | null, archived: boolean, clearScoped: boolean) => {
    const next = new URLSearchParams(params.toString());
    if (clearScoped) for (const k of SCOPED_PARAMS) next.delete(k);
    if (cycle && cycle !== current?.code) next.set("cycle", cycle);
    else next.delete("cycle");
    if (archived) next.set("archived", "1");
    else next.delete("archived");
    const qs = next.toString();
    startTransition(() => router.push(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { scroll: false }));
  };

  if (catalog.length === 0) return null;
  const inScope = (selected?.projects ?? []).filter((p) => p.status === "active" || selected?.status === "archived" || includeArchived);
  const snapshots = inScope.map((p) => p.snapshot_at).filter((s): s is string => Boolean(s)).sort();
  const spreadDays = snapshots.length > 1 ? (Date.parse(snapshots[snapshots.length - 1]) - Date.parse(snapshots[0])) / 86_400_000 : 0;
  const archivedCount = selected?.projects.filter((p) => p.status === "archived").length ?? 0;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className={cn("h-8 min-w-0 gap-1.5", historical && "border-amber-500/60 bg-amber-500/10")} aria-label="Choose reporting cycle">
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : historical ? <History className="size-3.5" /> : <Database className="size-3.5" />}
            <span className="max-w-[11rem] truncate">{selected ? selected.name : "No current cycle"}</span>
            {historical && <span className="hidden text-[11px] font-normal text-amber-700 dark:text-amber-400 sm:inline">History</span>}
            <ChevronsUpDown className="size-3 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <div className="border-b p-3">
            <p className="text-sm font-medium">Reporting cycle</p>
            <p className="text-xs text-muted-foreground">Analytics always cover one cycle. Archived data is shown only when you choose it.</p>
          </div>
          <ul className="max-h-72 overflow-y-auto p-1">
            {catalog.map((c) => {
              const active = c.code === selected?.code;
              return (
                <li key={c.code}>
                  <button
                    type="button"
                    onClick={() => go(c.code, false, c.code !== selected?.code)}
                    className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent", active && "bg-accent/60")}
                  >
                    <Check className={cn("mt-0.5 size-3.5 shrink-0", !active && "invisible")} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{c.name}</span>
                        {c.is_current && <span className="rounded bg-primary/10 px-1 text-[10px] font-medium text-primary">Current</span>}
                        {c.status === "archived" && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                            <Archive className="size-2.5" /> Archived
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {c.projects.filter((p) => p.status === "active").length} active · {c.projects.filter((p) => p.status === "archived").length} archived project(s)
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected && selected.status !== "archived" && archivedCount > 0 && (
            <div className="flex items-center justify-between gap-3 border-t p-3">
              <Label htmlFor="scope-archived" className="text-xs font-normal">
                Include {archivedCount} archived project{archivedCount === 1 ? "" : "s"} of this cycle
              </Label>
              <Switch id="scope-archived" checked={includeArchived} onCheckedChange={(v) => go(selected.code, v, true)} />
            </div>
          )}
        </PopoverContent>
      </Popover>

      {snapshots.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="hidden min-w-0 items-center gap-1.5 truncate rounded-full border px-2.5 py-1 text-xs text-muted-foreground md:inline-flex">
              {spreadDays >= 1 ? (
                <>
                  Exports end {fmtDate(snapshots[0])} – {fmtDate(snapshots[snapshots.length - 1])}
                </>
              ) : (
                <>Historical export · data as of {fmtDateTime(snapshots[snapshots.length - 1])}</>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            <p className="mb-1 font-medium">Latest export per project (Africa/Cairo)</p>
            <ul className="space-y-0.5">
              {inScope.map((p) => (
                <li key={p.code} className="flex justify-between gap-4">
                  <span>
                    {p.name}
                    {p.status === "archived" ? " (archived)" : ""}
                  </span>
                  <span className="tabular">{fmtDateTime(p.snapshot_at)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-muted-foreground">
              Figures come from imported exports, not the live ticketing system. Statuses reflect each project&apos;s export snapshot
              {spreadDays >= 1 ? "; projects were exported on different dates, so recent days are incomplete for some of them." : "."}
            </p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
