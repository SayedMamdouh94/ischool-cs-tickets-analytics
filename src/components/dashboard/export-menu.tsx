"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { filterQuery } from "@/components/layout/nav-items";
import { can } from "@/lib/auth/permissions";

/**
 * Export actions for the current filtered view, limited to what the viewer's
 * role grants. The download routes and PostgreSQL re-check every permission
 * (and the project scope) and audit each download; the menu only hides what
 * the server would refuse.
 */
export function ExportMenu({ permissions, aggregate }: { permissions: readonly string[]; aggregate?: { dataset: string; label: string }[] }) {
  const params = useSearchParams();
  const q = filterQuery(params);
  const join = (base: string, extra: string) => `${base}${q ? `${q}&` : "?"}${extra}`;
  const aggregates = can(permissions, "export.aggregate") ? (aggregate ?? []) : [];
  const tickets = can(permissions, "export.tickets");
  const withText = tickets && can(permissions, "tickets.read_content");
  const summary = can(permissions, "page.reports");
  if (aggregates.length === 0 && !tickets && !summary) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Download /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Exports respect the active filters</DropdownMenuLabel>
        {aggregates.map((a) => (
          <DropdownMenuItem key={a.dataset} asChild>
            <a href={join("/api/export/aggregate", `dataset=${a.dataset}`)} download>
              <Download /> {a.label} (CSV)
            </a>
          </DropdownMenuItem>
        ))}
        {aggregates.length > 0 && (tickets || summary) && <DropdownMenuSeparator />}
        {tickets && (
          <DropdownMenuItem asChild>
            <a href={join("/api/export/tickets", "include_text=0")} download>
              <Download /> Filtered tickets — metadata (CSV)
            </a>
          </DropdownMenuItem>
        )}
        {withText && (
          <DropdownMenuItem asChild>
            <a href={join("/api/export/tickets", "include_text=1")} download>
              <Download /> Filtered tickets — with message text (CSV)
            </a>
          </DropdownMenuItem>
        )}
        {tickets && summary && <DropdownMenuSeparator />}
        {summary && (
          <DropdownMenuItem asChild>
            <Link href={`/reports/summary${q}`}>
              <FileText /> Printable management summary
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
