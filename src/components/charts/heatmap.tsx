"use client";

import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WEEKDAY_LABELS, fmtInt } from "@/lib/format";
import { SEQUENTIAL } from "./colors";

/** Weekday × hour-of-day volume (Africa/Cairo), single-hue sequential scale. */
export function WeekdayHourHeatmap({ cells }: { cells: { isodow: number; hour: number; count: number }[] }) {
  const { grid, max } = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    let m = 0;
    for (const c of cells) {
      g[c.isodow - 1][c.hour] = c.count;
      m = Math.max(m, c.count);
    }
    return { grid: g, max: m };
  }, [cells]);

  const step = (v: number) => (v === 0 || max === 0 ? -1 : Math.min(SEQUENTIAL.length - 1, Math.floor((v / max) * SEQUENTIAL.length)));
  const thresholds = SEQUENTIAL.map((_, i) => Math.round((max * i) / SEQUENTIAL.length));

  return (
    <div className="w-full overflow-x-auto">
      <div className="min-w-[640px]">
        <div className="grid grid-cols-[3rem_repeat(24,minmax(0,1fr))] gap-[2px]">
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="tabular pb-1 text-center text-[10px] text-muted-foreground">
              {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
            </div>
          ))}
          {grid.map((row, d) => (
            <div key={d} className="contents">
              <div className="pr-2 text-right text-[11px] leading-6 text-muted-foreground">{WEEKDAY_LABELS[d]}</div>
              {row.map((v, h) => {
                const s = step(v);
                return (
                  <Tooltip key={h}>
                    <TooltipTrigger asChild>
                      <div
                        role="img"
                        aria-label={`${WEEKDAY_LABELS[d]} ${String(h).padStart(2, "0")}:00 — ${fmtInt(v)} tickets`}
                        tabIndex={0}
                        className="h-6 rounded-[3px] outline-none ring-ring focus-visible:ring-2"
                        style={{ background: s < 0 ? "var(--muted)" : SEQUENTIAL[s] }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <span className="tabular">
                        {WEEKDAY_LABELS[d]} {String(h).padStart(2, "0")}:00–{String(h).padStart(2, "0")}:59 · <strong>{fmtInt(v)}</strong> tickets
                      </span>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
          <span>Fewer</span>
          <div className="flex gap-[2px]">
            {SEQUENTIAL.map((c, i) => (
              <span key={c} className="h-3 w-6 rounded-[2px]" style={{ background: c }} title={`≥ ${fmtInt(thresholds[i])}`} />
            ))}
          </div>
          <span>More (max {fmtInt(max)} per hour slot)</span>
        </div>
      </div>
    </div>
  );
}
