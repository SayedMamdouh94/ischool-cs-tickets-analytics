import { Archive, CheckCircle2, CircleDashed, Loader2, PauseCircle, TriangleAlert, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { JOB_STATUS_LABELS, type ImportJobStatus } from "@/lib/imports/types";
import type { LifecycleStatus } from "@/lib/analytics/types";
import { cn } from "@/lib/utils";

const JOB_TONE: Record<ImportJobStatus, { className: string; icon: typeof CheckCircle2; spin?: boolean }> = {
  awaiting_upload: { className: "text-muted-foreground", icon: CircleDashed },
  uploaded: { className: "text-sky-700 dark:text-sky-300 border-sky-500/40", icon: Loader2, spin: true },
  validating: { className: "text-sky-700 dark:text-sky-300 border-sky-500/40", icon: Loader2, spin: true },
  ready: { className: "text-amber-800 dark:text-amber-300 border-amber-500/50 bg-amber-500/10", icon: PauseCircle },
  importing: { className: "text-sky-700 dark:text-sky-300 border-sky-500/40", icon: Loader2, spin: true },
  completed: { className: "text-emerald-700 dark:text-emerald-300 border-emerald-500/40", icon: CheckCircle2 },
  completed_with_errors: { className: "text-emerald-700 dark:text-emerald-300 border-amber-500/50", icon: TriangleAlert },
  failed: { className: "text-destructive border-destructive/40", icon: XCircle },
  cancelled: { className: "text-muted-foreground", icon: XCircle },
};

export function JobStatusBadge({ status, stalled = false, className }: { status: ImportJobStatus; stalled?: boolean; className?: string }) {
  const tone = JOB_TONE[status];
  const Icon = stalled ? TriangleAlert : tone.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 font-normal", stalled ? "border-amber-500/50 text-amber-800 dark:text-amber-300" : tone.className, className)}>
      <Icon className={cn("size-3", tone.spin && !stalled && "animate-spin")} aria-hidden />
      {stalled ? `${JOB_STATUS_LABELS[status]} (waiting for worker)` : JOB_STATUS_LABELS[status]}
    </Badge>
  );
}

export function LifecycleBadge({ status, className }: { status: LifecycleStatus; className?: string }) {
  if (status === "active") {
    return (
      <Badge variant="outline" className={cn("gap-1 border-emerald-500/40 font-normal text-emerald-700 dark:text-emerald-300", className)}>
        <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden /> Active
      </Badge>
    );
  }
  if (status === "archived") {
    return (
      <Badge variant="outline" className={cn("gap-1 font-normal text-muted-foreground", className)}>
        <Archive className="size-3" aria-hidden /> Archived
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cn("gap-1 border-amber-500/50 font-normal text-amber-800 dark:text-amber-300", className)}>
      <CircleDashed className="size-3" aria-hidden /> Draft (import pending)
    </Badge>
  );
}
