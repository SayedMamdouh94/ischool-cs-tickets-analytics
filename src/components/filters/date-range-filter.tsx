"use client";

import { useState } from "react";
import type { DateRange as DayPickerRange } from "react-day-picker";
import { CalendarDays, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { DATE_PRESETS, DATE_PRESET_LABELS, type DatePreset, type DateRange } from "@/lib/filters/schema";
import { fmtCalendarDate } from "@/lib/format";
import { cn } from "@/lib/utils";

function toDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function DateRangeFilter({
  preset,
  range,
  datasetMin,
  datasetMax,
  anchorLabel,
  onChange,
}: {
  preset: DatePreset;
  range: DateRange;
  datasetMin: string | null;
  datasetMax: string | null;
  anchorLabel: string;
  onChange: (next: { preset: DatePreset; from?: string; to?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState<DayPickerRange | undefined>(
    range.from ? { from: toDate(range.from), to: range.to ? toDate(range.to) : undefined } : undefined,
  );

  const label =
    preset === "all"
      ? DATE_PRESET_LABELS.all
      : range.from && range.to
        ? `${fmtCalendarDate(range.from)} – ${fmtCalendarDate(range.to)}`
        : DATE_PRESET_LABELS[preset];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-8 gap-1.5 font-normal", preset !== "all" ? "border-solid" : "border-dashed")}>
          <CalendarDays className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Created</span>
          <span className="max-w-[14rem] truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex flex-col sm:flex-row">
          <div className="flex min-w-48 flex-col p-1.5">
            {DATE_PRESETS.filter((p) => p !== "custom").map((p) => (
              <button
                key={p}
                type="button"
                className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  setOpen(false);
                  onChange({ preset: p });
                }}
              >
                {DATE_PRESET_LABELS[p]}
                {preset === p && <Check className="size-4" strokeWidth={2.5} aria-hidden />}
              </button>
            ))}
            <Separator className="my-1.5" />
            <p className="px-2.5 pb-1 text-[11px] leading-snug text-muted-foreground">
              Presets end at {anchorLabel}.
              {datasetMin && datasetMax && (
                <>
                  <br />
                  Available: {fmtCalendarDate(datasetMin)} – {fmtCalendarDate(datasetMax)}
                </>
              )}
            </p>
          </div>
          <Separator orientation="vertical" className="hidden sm:block" />
          <div className="p-2">
            <p className="px-1 pb-1 text-xs font-medium">Custom range</p>
            <Calendar
              mode="range"
              numberOfMonths={1}
              selected={custom}
              onSelect={setCustom}
              defaultMonth={custom?.from ?? (datasetMax ? toDate(datasetMax) : undefined)}
              startMonth={datasetMin ? toDate(datasetMin) : undefined}
              endMonth={datasetMax ? toDate(datasetMax) : undefined}
            />
            <div className="flex justify-end gap-2 px-1 pt-1">
              <Button
                size="sm"
                disabled={!custom?.from}
                onClick={() => {
                  if (!custom?.from) return;
                  setOpen(false);
                  onChange({ preset: "custom", from: toIso(custom.from), to: toIso(custom.to ?? custom.from) });
                }}
              >
                Apply range
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
