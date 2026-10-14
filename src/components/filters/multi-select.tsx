"use client";

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
  hint?: string;
}

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  searchable = true,
  className,
}: {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  searchable?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(selected);
  const labelFor = useMemo(() => new Map(options.map((o) => [o.value, o.label])), [options]);

  const summary =
    selected.length === 0 ? null : selected.length === 1 ? (labelFor.get(selected[0]) ?? selected[0]) : `${selected.length} selected`;

  const toggle = (value: string) =>
    setDraft((d) => (d.includes(value) ? d.filter((v) => v !== value) : [...d, value]));

  const apply = (values: string[]) => {
    setOpen(false);
    const same = values.length === selected.length && values.every((v) => selected.includes(v));
    if (!same) onChange(values);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setDraft(selected);
        else apply(draft);
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("h-8 max-w-[15rem] justify-between gap-1.5 border-dashed font-normal", selected.length > 0 && "border-solid", className)}
          aria-label={`${label} filter`}
        >
          <span className="text-muted-foreground">{label}</span>
          {summary && (
            <Badge variant="secondary" className="max-w-[9rem] truncate rounded-sm px-1.5 font-normal">
              <span className="truncate">{summary}</span>
            </Badge>
          )}
          <ChevronsUpDown className="size-3.5 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          {searchable && <CommandInput placeholder={`Search ${label.toLowerCase()}…`} />}
          <CommandList className="max-h-72">
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const isSelected = draft.includes(o.value);
                return (
                  <CommandItem key={o.value} value={`${o.label} ${o.value}`} onSelect={() => toggle(o.value)}>
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                        isSelected ? "border-primary bg-primary text-primary-foreground" : "opacity-60",
                      )}
                      aria-hidden
                    >
                      {isSelected && <Check className="size-3" />}
                    </span>
                    <span className="user-text flex-1 truncate" dir="auto">
                      {o.label}
                    </span>
                    {o.hint && <span className="tabular ml-auto text-xs text-muted-foreground">{o.hint}</span>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
          <CommandSeparator />
          <div className="flex items-center justify-between gap-2 p-2">
            <Button variant="ghost" size="sm" onClick={() => setDraft([])} disabled={draft.length === 0}>
              <X /> Clear
            </Button>
            <Button size="sm" onClick={() => apply(draft)}>
              Apply
            </Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
