"use client";

import { useSearchParams } from "next/navigation";
import { RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DateRangeFilter } from "./date-range-filter";
import { MultiSelect, type MultiSelectOption } from "./multi-select";
import { useFilterTransition } from "./filter-transition";
import {
  LIST_FILTERS,
  NONE_TOKEN,
  activeFilterCount,
  filtersToSearchParams,
  parseFilters,
  type DashboardFilters,
  type DatePreset,
  type DateRange,
  type ListField,
} from "@/lib/filters/schema";
import type { FilterOptions } from "@/lib/analytics/types";
import { fmtCalendarDate, fmtInt, statusLabel } from "@/lib/format";

export type FilterKey = "date" | ListField;

const DEFAULT_KEYS: FilterKey[] = ["date", "projects", "programs", "intakes", "statuses", "topics", "responders", "resolvers"];

export function FilterBar({
  options,
  range,
  anchor,
  keys = DEFAULT_KEYS,
}: {
  options: FilterOptions;
  range: DateRange;
  anchor: "dataset_end" | "today";
  keys?: FilterKey[];
}) {
  const params = useSearchParams();
  const { navigate, isPending } = useFilterTransition();
  const filters = parseFilters(new URLSearchParams(params.toString()));

  const update = (patch: Partial<DashboardFilters>) => {
    const base = new URLSearchParams(params.toString());
    base.delete("page"); // a new slice starts at page 1
    navigate(filtersToSearchParams({ ...filters, ...patch }, base));
  };

  const reset = () => {
    const base = new URLSearchParams(params.toString());
    base.delete("page");
    // Reset clears the filters but keeps the chosen reporting cycle / historical view.
    navigate(filtersToSearchParams({ ...parseFilters(new URLSearchParams()), cycle: filters.cycle, archived: filters.archived }, base));
  };

  const categories = options.categories.filter((c) => c.kind === "category");
  const themes = options.categories.filter((c) => c.kind === "subcategory");
  const optionSets: Record<ListField, { label: string; options: MultiSelectOption[] }> = {
    projects: { label: "Project", options: options.projects.map((p) => ({ value: p.code, label: p.name })) },
    programs: { label: "Program", options: options.programs.map((p) => ({ value: p, label: p })) },
    intakes: { label: "Intake", options: options.intakes.map((i) => ({ value: i, label: i })) },
    statuses: {
      label: "Status",
      options: options.statuses.map((s) => ({ value: s.value, label: statusLabel(s.value === NONE_TOKEN ? null : s.value), hint: fmtInt(s.count) })),
    },
    topics: { label: "Topic", options: options.topics.map((t) => ({ value: t.value, label: t.value, hint: fmtInt(t.count) })) },
    responders: {
      label: "Responder",
      options: options.responders.map((r) => ({ value: r.value, label: r.value === NONE_TOKEN ? "Not recorded" : r.value, hint: fmtInt(r.count) })),
    },
    resolvers: {
      label: "Resolver",
      options: options.resolvers.map((r) => ({ value: r.value, label: r.value === NONE_TOKEN ? "Not recorded" : r.value, hint: fmtInt(r.count) })),
    },
    categories: { label: "Category", options: categories.map((c) => ({ value: c.code, label: c.name })) },
    subcategories: { label: "Issue theme", options: themes.map((c) => ({ value: c.code, label: c.name })) },
  };

  const count = activeFilterCount(filters);
  const anchorLabel = anchor === "today" ? "today" : `the latest ticket (${fmtCalendarDate(options.date_range.max)})`;

  return (
    <section aria-label="Filters" data-print-hide className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {keys.includes("date") && (
          <DateRangeFilter
            preset={filters.preset}
            range={range}
            datasetMin={options.date_range.min}
            datasetMax={options.date_range.max}
            anchorLabel={anchorLabel}
            onChange={({ preset, from, to }: { preset: DatePreset; from?: string; to?: string }) => update({ preset, from, to })}
          />
        )}
        {(Object.keys(LIST_FILTERS) as (keyof typeof LIST_FILTERS)[])
          .map((param) => LIST_FILTERS[param])
          .filter((field) => keys.includes(field))
          .map((field) => (
            <MultiSelect
              key={field}
              label={optionSets[field].label}
              options={optionSets[field].options}
              selected={filters[field]}
              searchable={optionSets[field].options.length > 8}
              onChange={(values) => update({ [field]: values } as Partial<DashboardFilters>)}
            />
          ))}
        {count > 0 && (
          <Button variant="ghost" size="sm" className="h-8" onClick={reset} disabled={isPending}>
            <RotateCcw /> Reset{count > 1 ? ` (${count})` : ""}
          </Button>
        )}
      </div>
      {(filters.session || filters.lesson || filters.categories.length > 0 || filters.subcategories.length > 0) &&
        !keys.includes("subcategories") && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Also filtered by:</span>
            {filters.session && <Chip label={`Session ${filters.session}`} onClear={() => update({ session: undefined })} />}
            {filters.lesson && <Chip label={`Lesson: ${filters.lesson}`} onClear={() => update({ lesson: undefined })} />}
            {filters.categories.map((c) => (
              <Chip key={c} label={`Category: ${categories.find((x) => x.code === c)?.name ?? c}`} onClear={() => update({ categories: filters.categories.filter((x) => x !== c) })} />
            ))}
            {filters.subcategories.map((c) => (
              <Chip key={c} label={`Theme: ${themes.find((x) => x.code === c)?.name ?? c}`} onClear={() => update({ subcategories: filters.subcategories.filter((x) => x !== c) })} />
            ))}
          </div>
        )}
    </section>
  );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <Badge variant="secondary" className="gap-1 pr-1 font-normal">
      <span className="user-text max-w-[16rem] truncate" dir="auto">
        {label}
      </span>
      <button type="button" onClick={onClear} className="rounded-sm p-0.5 hover:bg-muted-foreground/20" aria-label={`Remove ${label}`}>
        <X className="size-3" />
      </button>
    </Badge>
  );
}
