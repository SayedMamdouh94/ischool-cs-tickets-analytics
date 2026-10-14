"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Download, FileText, Lock } from "lucide-react";
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

/**
 * Export actions for the current filtered view. Ticket-level exports are
 * served by /api/export/tickets, which re-checks the administrator role and
 * audits every download; the menu only hides what the server would refuse.
 */
export function ExportMenu({ role, aggregate }: { role: "admin" | "analyst"; aggregate?: { dataset: string; label: string }[] }) {
  const params = useSearchParams();
  const q = filterQuery(params);
  const join = (base: string, extra: string) => `${base}${q ? `${q}&` : "?"}${extra}`;
  const isAdmin = role === "admin";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Download /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Exports respect the active filters</DropdownMenuLabel>
        {aggregate?.map((a) => (
          <DropdownMenuItem key={a.dataset} asChild>
            <a href={join("/api/export/aggregate", `dataset=${a.dataset}`)} download>
              <Download /> {a.label} (CSV)
            </a>
          </DropdownMenuItem>
        ))}
        {aggregate && aggregate.length > 0 && <DropdownMenuSeparator />}
        {isAdmin ? (
          <>
            <DropdownMenuItem asChild>
              <a href={join("/api/export/tickets", "include_text=0")} download>
                <Download /> Filtered tickets — metadata (CSV)
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={join("/api/export/tickets", "include_text=1")} download>
                <Download /> Filtered tickets — with message text (CSV)
              </a>
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem disabled>
            <Lock /> Ticket-level exports require an administrator
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={`/reports/summary${q}`}>
            <FileText /> Printable management summary
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
