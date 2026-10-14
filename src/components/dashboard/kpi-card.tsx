import { ArrowDownRight, ArrowUpRight, Info, Minus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface KpiDelta {
  /** Relative change, e.g. 0.12 = +12%. */
  value: number | null;
  label: string;
  /** Whether an increase is good, bad, or neutral for this metric. */
  goodDirection?: "up" | "down" | "neutral";
}

export function KpiCard({
  label,
  value,
  sub,
  info,
  delta,
  className,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  info: string;
  delta?: KpiDelta;
  className?: string;
}) {
  return (
    <Card className={cn("gap-0 py-0 shadow-xs", className)}>
      <CardContent className="flex h-full flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="-m-1 rounded p-1 text-muted-foreground/70 hover:text-foreground" aria-label={`About ${label}`}>
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-pretty">{info}</TooltipContent>
          </Tooltip>
        </div>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {delta && <DeltaBadge delta={delta} />}
          {sub}
        </div>
      </CardContent>
    </Card>
  );
}

function DeltaBadge({ delta }: { delta: KpiDelta }) {
  if (delta.value === null) {
    return <span className="text-muted-foreground">No prior period</span>;
  }
  const up = delta.value > 0;
  const flat = Math.abs(delta.value) < 0.005;
  const good = delta.goodDirection === "neutral" || flat ? null : (delta.goodDirection === "up") === up;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-medium",
        good === true && "text-[#006300] dark:text-[#0ca30c]",
        good === false && "text-destructive",
        good === null && "text-foreground",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {flat ? "0%" : `${up ? "+" : "−"}${Math.abs(delta.value * 100).toFixed(1)}%`}
      <span className="font-normal text-muted-foreground">{delta.label}</span>
    </span>
  );
}
