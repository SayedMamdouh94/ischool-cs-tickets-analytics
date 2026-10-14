"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { formatCell, type ColumnKind } from "@/lib/table-data";
import { ACCENT } from "./colors";

export interface BarListDatum {
  label: string;
  value: number;
  color?: string;
  /** Optional secondary line shown in the tooltip. */
  detail?: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Horizontal bars for comparing categories (topics, people, statuses). */
export function BarListChart({
  data,
  kind = "int",
  labelWidth = 190,
  barSize = 16,
  valueLabel = "Tickets",
}: {
  data: BarListDatum[];
  kind?: ColumnKind;
  labelWidth?: number;
  barSize?: number;
  valueLabel?: string;
}) {
  const config: ChartConfig = { value: { label: valueLabel, color: ACCENT } };
  const height = Math.max(120, data.length * (barSize + 14) + 24);
  const maxChars = Math.floor(labelWidth / 6.5);

  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 64, left: 0, bottom: 0 }} barCategoryGap={4} accessibilityLayer>
        <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
        <XAxis type="number" hide domain={[0, "dataMax"]} />
        <YAxis
          type="category"
          dataKey="label"
          width={labelWidth}
          tickLine={false}
          axisLine={false}
          interval={0}
          tick={({ x, y, payload }) => (
            <text x={Number(x) - 6} y={Number(y)} dy={4} textAnchor="end" className="fill-muted-foreground text-[11px]">
              <title>{payload.value}</title>
              {truncate(String(payload.value), maxChars)}
            </text>
          )}
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.5 }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as BarListDatum;
            return (
              <div className="grid min-w-40 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
                <span className="user-text font-medium" dir="auto">
                  {d.label}
                </span>
                <span className="tabular text-muted-foreground">
                  {valueLabel}: <span className="font-medium text-foreground">{formatCell(d.value, kind)}</span>
                </span>
                {d.detail && <span className="text-muted-foreground">{d.detail}</span>}
              </div>
            );
          }}
        />
        <Bar dataKey="value" barSize={barSize} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.color ?? "var(--color-value)"} />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            offset={6}
            className="tabular fill-foreground text-[11px]"
            formatter={(v: unknown) => formatCell(Number(v), kind)}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
