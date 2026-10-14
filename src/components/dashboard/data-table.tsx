"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCell, isNumericKind, type TableData } from "@/lib/table-data";
import { cn } from "@/lib/utils";

/** Small client-side sortable table for aggregated data (never raw ticket lists). */
export function DataTable({
  table,
  maxHeight,
  initialSort,
  renderCell,
  className,
}: {
  table: TableData;
  maxHeight?: number;
  initialSort?: { key: string; dir: "asc" | "desc" };
  renderCell?: (columnKey: string, row: TableData["rows"][number]) => React.ReactNode | undefined;
  className?: string;
}) {
  const [sort, setSort] = useState(initialSort ?? null);

  const rows = useMemo(() => {
    if (!sort) return table.rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...table.rows].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [table.rows, sort]);

  const toggle = (key: string) =>
    setSort((s) => (s?.key === key ? (s.dir === "desc" ? { key, dir: "asc" } : null) : { key, dir: "desc" }));

  return (
    <div className={cn("overflow-auto rounded-md border", className)} style={maxHeight ? { maxHeight } : undefined}>
      <Table className="text-xs">
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow>
            {table.columns.map((c) => {
              const active = sort?.key === c.key;
              const Icon = !active ? ArrowUpDown : sort?.dir === "asc" ? ArrowUp : ArrowDown;
              return (
                <TableHead key={c.key} className={cn("h-9 whitespace-nowrap", isNumericKind(c.kind) && "text-right")} aria-sort={active ? (sort?.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggle(c.key)} className={cn("inline-flex items-center gap-1 hover:text-foreground", isNumericKind(c.kind) && "flex-row-reverse")}>
                    {c.label}
                    <Icon className={cn("size-3", !active && "opacity-40")} aria-hidden />
                  </button>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={table.columns.length} className="py-6 text-center text-muted-foreground">
                No rows
              </TableCell>
            </TableRow>
          )}
          {rows.map((r, i) => (
            <TableRow key={i}>
              {table.columns.map((c) => {
                const custom = renderCell?.(c.key, r);
                return (
                  <TableCell key={c.key} className={cn("py-2", isNumericKind(c.kind) ? "tabular text-right" : "user-text max-w-[28rem]")} dir={isNumericKind(c.kind) ? undefined : "auto"}>
                    {custom ?? formatCell(r[c.key] ?? null, c.kind)}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
