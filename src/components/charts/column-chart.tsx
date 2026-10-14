"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { fmtCompact } from "@/lib/format";
import { formatCell, type ColumnKind } from "@/lib/table-data";

export interface ColumnSeries {
  key: string;
  label: string;
  color: string;
}

/** Vertical columns per category, grouped or stacked by series. */
export function ColumnChart({
  data,
  categoryKey = "category",
  series,
  stacked = false,
  kind = "int",
  height = 260,
  yTickFormat,
}: {
  data: Record<string, string | number | null>[];
  categoryKey?: string;
  series: ColumnSeries[];
  stacked?: boolean;
  kind?: ColumnKind;
  height?: number;
  yTickFormat?: "compact" | "hours";
}) {
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]));
  const barSize = Math.max(6, Math.min(24, Math.floor(480 / Math.max(1, data.length * (stacked ? 1 : series.length)))));

  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2} accessibilityLayer>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis dataKey={categoryKey} tickLine={false} axisLine={{ stroke: "var(--chart-grid)" }} tickMargin={8} interval={0} className="text-[11px]" />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={48}
          className="tabular"
          tickFormatter={(v: number) => (yTickFormat === "hours" ? `${Math.round(v)}h` : fmtCompact(v))}
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.5 }}
          content={
            <ChartTooltipContent
              formatter={(value, name, item) => (
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-[2px]" style={{ background: item.color }} aria-hidden />
                    {config[String(name)]?.label ?? name}
                  </span>
                  <span className="tabular font-medium text-foreground">{formatCell(value as number, kind)}</span>
                </div>
              )}
            />
          }
        />
        {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            fill={`var(--color-${s.key})`}
            stackId={stacked ? "a" : undefined}
            barSize={barSize}
            radius={stacked ? (i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]) : [4, 4, 0, 0]}
            stroke={stacked ? "var(--card)" : undefined}
            strokeWidth={stacked ? 1 : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
