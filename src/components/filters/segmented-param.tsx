"use client";

import { useSearchParams } from "next/navigation";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useFilterTransition } from "./filter-transition";

/** A URL-backed segmented control for page-level view options (grain, split, …). */
export function SegmentedParam({
  param,
  options,
  defaultValue,
  label,
}: {
  param: string;
  options: { value: string; label: string }[];
  defaultValue: string;
  label: string;
}) {
  const params = useSearchParams();
  const { navigate } = useFilterTransition();
  const current = params.get(param) ?? defaultValue;
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={current}
      aria-label={label}
      onValueChange={(v) => {
        if (!v) return;
        const next = new URLSearchParams(params.toString());
        if (v === defaultValue) next.delete(param);
        else next.set(param, v);
        navigate(next);
      }}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className="px-3 text-xs">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
