import Link from "next/link";
import { AlertTriangle, ArrowRight, Eye, Info, Lightbulb } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { Insight } from "@/lib/analytics/insights";
import { hrefWithFilters, type DashboardFilters } from "@/lib/filters/schema";
import { cn } from "@/lib/utils";

const SEVERITY = {
  attention: { label: "Needs attention", icon: AlertTriangle, className: "text-[var(--status-critical)]" },
  watch: { label: "Watch", icon: Eye, className: "text-[var(--status-serious)]" },
  info: { label: "Context", icon: Info, className: "text-muted-foreground" },
} as const;

const KIND = {
  observation: { label: "Observation", className: "font-normal" },
  recommendation: { label: "Recommendation", className: "border-primary/40 font-medium text-primary" },
  caveat: { label: "Data caveat", className: "border-amber-500/50 font-normal text-amber-800 dark:text-amber-300" },
} as const;

const AREA_LABELS: Record<Insight["area"], string> = {
  volume: "Volume",
  trend: "Trend",
  resolution: "Resolution",
  backlog: "Backlog",
  recurring: "Recurring issue",
  data: "Data caveat",
};

export function InsightCard({ insight, filters, compact = false }: { insight: Insight; filters: DashboardFilters; compact?: boolean }) {
  const sev = SEVERITY[insight.severity];
  const Icon = sev.icon;
  const href = insight.link
    ? `${hrefWithFilters(insight.link.pathname, filters, insight.link.overrides ?? {}, insight.link.extra ?? {})}${insight.link.hash ? `#${insight.link.hash}` : ""}`
    : null;
  return (
    <Card className="h-full gap-0 py-0 shadow-xs">
      <CardContent className="flex h-full flex-col gap-2.5 p-4">
        <div className="flex items-center gap-2 text-xs">
          <span className={cn("inline-flex items-center gap-1 font-medium", sev.className)}>
            <Icon className="size-3.5" aria-hidden />
            {sev.label}
          </span>
          <Badge variant="outline" className={KIND[insight.kind].className}>
            {KIND[insight.kind].label}
          </Badge>
          {insight.area !== "data" && (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {AREA_LABELS[insight.area]}
            </Badge>
          )}
        </div>
        <p className="user-text text-sm font-semibold leading-snug" dir="auto">
          {insight.title}
        </p>
        <p className="user-text text-sm text-muted-foreground" dir="auto">
          {insight.statement}
        </p>
        {insight.recommendation && (
          <p className="flex items-start gap-1.5 rounded-md border border-primary/20 bg-primary/5 p-2 text-xs">
            <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
            <span>
              <span className="font-medium">Suggested action: </span>
              {insight.recommendation}
            </span>
          </p>
        )}
        {!compact && insight.method && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none font-medium text-foreground/80">How this was compared</summary>
            <p className="mt-1">{insight.method}</p>
          </details>
        )}
        {!compact && insight.evidence.length > 0 && (
          <dl className="mt-1 grid gap-1 rounded-md bg-muted/50 p-2.5 text-xs">
            {insight.evidence.map((e) => (
              <div key={e.label} className="flex items-start justify-between gap-3">
                <dt className="user-text text-muted-foreground" dir="auto">
                  {e.label}
                </dt>
                <dd className="tabular text-right font-medium">{e.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {href && insight.link && (
          <Link href={href} className="mt-auto inline-flex items-center gap-1 pt-1 text-xs font-medium text-primary underline-offset-4 hover:underline">
            {insight.link.label} <ArrowRight className="size-3" aria-hidden />
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
