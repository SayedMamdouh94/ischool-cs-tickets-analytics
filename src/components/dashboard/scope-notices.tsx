import Link from "next/link";
import { History, Loader2, TriangleAlert } from "lucide-react";
import type { FilterOptions } from "@/lib/analytics/types";
import { fmtInt } from "@/lib/format";

/** Explicit context lines about WHAT data the page shows (never shown silently). */
export function ScopeNotices({ options, isAdmin }: { options: FilterOptions; isAdmin: boolean }) {
  const notes: React.ReactNode[] = [];
  const scope = options.scope;

  if (!scope) {
    notes.push(
      <Note key="none" tone="warn" icon={TriangleAlert}>
        No reporting cycle is selected as current, so there is nothing to show.{" "}
        {isAdmin ? (
          <Link href="/settings?tab=projects" className="font-medium underline underline-offset-2">
            Choose a current cycle
          </Link>
        ) : (
          "Ask an administrator to choose the current cycle."
        )}
      </Note>,
    );
  } else if (scope.cycle_status === "archived") {
    notes.push(
      <Note key="hist" tone="hist" icon={History}>
        Historical view: <strong>{scope.cycle_name}</strong> is archived. These figures are not part of the current reporting cycle.
      </Note>,
    );
  } else if (scope.include_archived) {
    const archived = options.projects.filter((p) => p.status === "archived");
    if (archived.length > 0) {
      notes.push(
        <Note key="arch" tone="hist" icon={History}>
          Including archived project{archived.length === 1 ? "" : "s"}: {archived.map((p) => p.name).join(", ")}.
        </Note>,
      );
    }
  }

  for (const imp of options.active_imports) {
    notes.push(
      <Note key={`imp-${imp.project}`} tone="warn" icon={Loader2} spin>
        Import in progress for {options.projects.find((p) => p.code === imp.project)?.name ?? imp.project}: {fmtInt(imp.rows_applied)} of{" "}
        {fmtInt(imp.rows_to_apply)} rows applied. Its figures are incomplete until the import finishes.
      </Note>,
    );
  }

  if (notes.length === 0) return null;
  return <div className="flex flex-col gap-1.5">{notes}</div>;
}

function Note({ tone, icon: Icon, spin, children }: { tone: "warn" | "hist"; icon: typeof History; spin?: boolean; children: React.ReactNode }) {
  return (
    <p
      role="status"
      className={
        tone === "warn"
          ? "flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
          : "flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
      }
    >
      <Icon className={`mt-0.5 size-3.5 shrink-0 ${spin ? "animate-spin" : ""}`} aria-hidden />
      <span>{children}</span>
    </p>
  );
}
