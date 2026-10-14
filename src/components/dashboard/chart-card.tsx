"use client";

import { useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Download, ImageDown, Info, Table2, BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DataTable } from "./data-table";
import { downloadElementAsPng, slugify, triggerDownload } from "@/lib/chart-export";
import { toCsv, type TableData } from "@/lib/table-data";
import { recordAggregateExport } from "@/lib/analytics/export-actions";
import { cn } from "@/lib/utils";

/**
 * Card wrapper for every chart: title, method note, and a Chart/Table toggle.
 * The table view is the accessible equivalent of the chart (and the CSV
 * export source), so no value is reachable only through color or hover.
 */
export function ChartCard({
  title,
  description,
  info,
  table,
  children,
  className,
  contentClassName,
  footer,
  exportName,
}: {
  title: string;
  description?: React.ReactNode;
  info?: string;
  table?: TableData;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  footer?: React.ReactNode;
  exportName?: string;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const chartRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const params = useSearchParams();
  const name = exportName ?? slugify(title);

  const downloadCsv = () => {
    if (!table) return;
    triggerDownload(new Blob([toCsv(table)], { type: "text/csv;charset=utf-8" }), `${name}.csv`);
    void recordAggregateExport({ kind: name.replace(/-/g, "_").slice(0, 50), rows: table.rows.length, path: `${pathname}?${params.toString()}` });
  };

  const downloadPng = async () => {
    if (!chartRef.current) return;
    try {
      await downloadElementAsPng(chartRef.current, `${name}.png`, title);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Card className={cn("min-w-0 gap-4 shadow-xs", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
          {title}
          {info && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="rounded p-0.5 text-muted-foreground/70 hover:text-foreground" aria-label={`About ${title}`}>
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-pretty">{info}</TooltipContent>
            </Tooltip>
          )}
        </CardTitle>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
        <CardAction data-print-hide className="flex items-center gap-0.5">
          {table && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setView((v) => (v === "chart" ? "table" : "chart"))}
              aria-label={view === "chart" ? "Show as table" : "Show as chart"}
              title={view === "chart" ? "Show as table" : "Show as chart"}
            >
              {view === "chart" ? <Table2 className="size-3.5" /> : <BarChart3 className="size-3.5" />}
            </Button>
          )}
          {view === "chart" && (
            <Button variant="ghost" size="icon" className="size-7" onClick={downloadPng} aria-label="Download chart as PNG" title="Download PNG">
              <ImageDown className="size-3.5" />
            </Button>
          )}
          {table && (
            <Button variant="ghost" size="icon" className="size-7" onClick={downloadCsv} aria-label="Download data as CSV" title="Download CSV">
              <Download className="size-3.5" />
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className={cn("min-w-0", contentClassName)}>
        {view === "chart" || !table ? (
          <div ref={chartRef} className="bg-card text-card-foreground">
            {children}
          </div>
        ) : (
          <DataTable table={table} maxHeight={360} />
        )}
        {footer && <div className="mt-3 text-xs text-muted-foreground">{footer}</div>}
      </CardContent>
    </Card>
  );
}
