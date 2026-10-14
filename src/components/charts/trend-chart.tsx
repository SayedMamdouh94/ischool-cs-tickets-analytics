"use client";

import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceDot, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { fmtBucket, fmtCalendarDate, fmtCompact, fmtInt } from "@/lib/format";

export interface TrendSeries {
  key: string;
  label: string;
  color: string;
}

export type TrendDatum = { bucket: string } & Record<string, number | string>;

export function TrendChart({
  data,
  series,
  grain,
  height = 280,
  variant = "line",
  markers = [],
  valueSuffix = "tickets",
}: {
  data: TrendDatum[];
  series: TrendSeries[];
  grain: "day" | "week" | "month";
  height?: number;
  variant?: "line" | "area";
  markers?: { bucket: string; value: number; label: string }[];
  valueSuffix?: string;
}) {
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]));
  const showLegend = series.length > 1;
  const Chart = variant === "area" ? AreaChart : LineChart;

  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <Chart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} accessibilityLayer>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis
          dataKey="bucket"
          tickLine={false}
          axisLine={{ stroke: "var(--chart-grid)" }}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(v: string) => fmtBucket(v, grain)}
          className="tabular"
        />
        <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => fmtCompact(v)} allowDecimals={false} className="tabular" />
        <ChartTooltip
          cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(_, payload) => {
                const b = payload?.[0]?.payload?.bucket as string | undefined;
                if (!b) return "";
                return grain === "week" ? `Week of ${fmtCalendarDate(b)}` : grain === "month" ? fmtBucket(b, "month") : fmtCalendarDate(b);
              }}
              formatter={(value, name, item) => (
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-[2px]" style={{ background: item.color }} aria-hidden />
                    {config[String(name)]?.label ?? name}
                  </span>
                  <span className="tabular font-medium text-foreground">
                    {fmtInt(Number(value))} {valueSuffix}
                  </span>
                </div>
              )}
            />
          }
        />
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((s) =>
          variant === "area" ? (
            <Area
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={`var(--color-${s.key})`}
              fill={`var(--color-${s.key})`}
              fillOpacity={0.1}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
              isAnimationActive={false}
            />
          ) : (
            <Line
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
              isAnimationActive={false}
            />
          ),
        )}
        {markers.map((m) => (
          <ReferenceDot
            key={m.bucket}
            x={m.bucket}
            y={m.value}
            r={5}
            fill="var(--status-serious)"
            stroke="var(--card)"
            strokeWidth={2}
            ifOverflow="extendDomain"
          />
        ))}
      </Chart>
    </ChartContainer>
  );
}
