"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFilterTransition } from "@/components/filters/filter-transition";
import { projectColor } from "@/components/charts/colors";
import type { TicketSearchResult } from "@/lib/analytics/types";
import { fmtDateTime, fmtDuration, fmtInt, keyLabel, statusLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const COLUMNS: { key: string; label: string; sortable: boolean; className?: string }[] = [
  { key: "ticket_id", label: "Ticket", sortable: true },
  { key: "project", label: "Project", sortable: true },
  { key: "topic", label: "Topic", sortable: true },
  { key: "status", label: "Status", sortable: true },
  { key: "owner_id", label: "Owner ID", sortable: true },
  { key: "created_at", label: "Created", sortable: true },
  { key: "responded_at", label: "Recorded response", sortable: true },
  { key: "resolved_at", label: "Resolved", sortable: true },
  { key: "responder_name", label: "Responder", sortable: true },
  { key: "resolved_by", label: "Resolver", sortable: true },
  { key: "resolution_seconds", label: "Resolution time", sortable: true, className: "text-right" },
];

export function TicketSearchBox({ contentSearch }: { contentSearch: boolean }) {
  const params = useSearchParams();
  const { navigate } = useFilterTransition();
  const initial = params.get("q") ?? "";
  const [value, setValue] = useState(initial);

  useEffect(() => {
    if (value === initial) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (value.trim()) next.set("q", value.trim().slice(0, 200));
      else next.delete("q");
      next.delete("page");
      navigate(next);
    }, 350);
    return () => clearTimeout(t);
  }, [value, initial, params, navigate]);

  return (
    <div className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={contentSearch ? "Ticket ID, owner, topic, lesson, agent, or message text…" : "Ticket ID, owner, topic, lesson or agent…"}
        className="h-9 pl-8"
        aria-label="Search tickets"
        dir="auto"
        maxLength={200}
      />
      {value && (
        <button type="button" onClick={() => setValue("")} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Clear search">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function TicketTable({ result }: { result: TicketSearchResult }) {
  const params = useSearchParams();
  const { navigate } = useFilterTransition();
  const pages = Math.max(1, Math.ceil(result.total / result.page_size));

  const setParam = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    navigate(next);
  };

  const sortBy = (key: string) => {
    const same = result.sort === key;
    setParam({ sort: key, dir: same && result.dir === "desc" ? "asc" : "desc", page: null });
  };

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border">
        <Table className="text-xs">
          <TableHeader className="bg-muted/40">
            <TableRow>
              {COLUMNS.map((c) => {
                const active = result.sort === c.key;
                const Icon = !active ? ArrowUpDown : result.dir === "asc" ? ArrowUp : ArrowDown;
                return (
                  <TableHead key={c.key} className={cn("h-9 whitespace-nowrap", c.className)} aria-sort={active ? (result.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => sortBy(c.key)}>
                      {c.label}
                      <Icon className={cn("size-3", !active && "opacity-40")} aria-hidden />
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={COLUMNS.length} className="py-10 text-center text-muted-foreground">
                  No tickets match. Adjust the search or filters.
                </TableCell>
              </TableRow>
            )}
            {result.rows.map((r) => (
              <TableRow key={`${r.project_code}-${r.ticket_id}`} className="cursor-pointer" onClick={() => setParam({ ticket: String(r.ticket_id), tproject: r.project_code })}>
                <TableCell>
                  <button type="button" className="tabular font-medium hover:underline" onClick={(e) => { e.stopPropagation(); setParam({ ticket: String(r.ticket_id), tproject: r.project_code }); }}>
                    #{r.ticket_id}
                  </button>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: projectColor(r.project_code) }} aria-hidden />
                    {r.project_name}
                  </span>
                </TableCell>
                <TableCell className="max-w-56 truncate" title={r.topic}>
                  {r.topic}
                </TableCell>
                <TableCell>
                  <Badge variant={r.status === "completed" ? "secondary" : "outline"} className="font-normal">
                    {statusLabel(r.status)}
                  </Badge>
                </TableCell>
                <TableCell className="tabular whitespace-nowrap">{r.owner_id ?? "—"}</TableCell>
                <TableCell className="tabular whitespace-nowrap">{fmtDateTime(r.created_at)}</TableCell>
                <TableCell className="tabular whitespace-nowrap">{fmtDateTime(r.responded_at)}</TableCell>
                <TableCell className="tabular whitespace-nowrap">{fmtDateTime(r.resolved_at)}</TableCell>
                <TableCell className="whitespace-nowrap">{keyLabel(r.responder_name, "—")}</TableCell>
                <TableCell className="whitespace-nowrap">{keyLabel(r.resolved_by, "—")}</TableCell>
                <TableCell className="tabular text-right">{fmtDuration(r.resolution_seconds)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {result.total === 0
            ? "0 tickets"
            : `${fmtInt((result.page - 1) * result.page_size + 1)}–${fmtInt(Math.min(result.total, result.page * result.page_size))} of ${fmtInt(result.total)} tickets`}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={result.page <= 1} onClick={() => setParam({ page: String(result.page - 1) })}>
            <ChevronLeft /> Previous
          </Button>
          <span className="tabular px-2">
            Page {fmtInt(result.page)} of {fmtInt(pages)}
          </span>
          <Button variant="outline" size="sm" disabled={result.page >= pages} onClick={() => setParam({ page: String(result.page + 1) })}>
            Next <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
