"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "./data-table";
import { hrefWithFilters, type DashboardFilters } from "@/lib/filters/schema";
import { toCsv, type TableData } from "@/lib/table-data";
import { triggerDownload } from "@/lib/chart-export";
import { recordAggregateExport } from "@/lib/analytics/export-actions";

/** Sortable comparison table with a color key per row and optional drill-down links. */
export function ComparisonTable({
  table,
  linkBase,
  filters,
  colorKeys,
  exportName = "comparison",
}: {
  table: TableData;
  linkBase?: string;
  filters: DashboardFilters;
  colorKeys?: Record<string, string>;
  exportName?: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <Card className="gap-0 py-0 shadow-xs">
      <CardContent className="p-0">
        <div className="flex items-center justify-end border-b px-3 py-1.5" data-print-hide>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              triggerDownload(new Blob([toCsv(table)], { type: "text/csv;charset=utf-8" }), `${exportName}.csv`);
              void recordAggregateExport({ kind: exportName, rows: table.rows.length, path: `${pathname}?${params.toString()}` });
            }}
          >
            <Download className="size-3.5" /> CSV
          </Button>
        </div>
        <DataTable
          table={table}
          className="rounded-none border-0"
          renderCell={(key, row) => {
            if (key !== "label") return undefined;
            const color = colorKeys?.[String(row.key)];
            const content = (
              <span className="inline-flex items-center gap-2 font-medium">
                {color && <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />}
                {String(row.label)}
              </span>
            );
            const href = typeof row.href === "string" ? row.href : linkBase ? hrefWithFilters(`${linkBase}/${row.key}`, filters) : null;
            return href ? (
              <Link href={href} className="hover:underline">
                {content}
              </Link>
            ) : (
              content
            );
          }}
        />
      </CardContent>
    </Card>
  );
}
