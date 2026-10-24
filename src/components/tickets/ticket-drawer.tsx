"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Maximize2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useFilterTransition } from "@/components/filters/filter-transition";

/** Detail drawer driven by the `ticket` URL parameter (shareable, back-button friendly). */
export function TicketDrawer({ ticketId, projectCode, children }: { ticketId: number; projectCode?: string | null; children: React.ReactNode }) {
  const params = useSearchParams();
  const { navigate } = useFilterTransition();
  const close = () => {
    const next = new URLSearchParams(params.toString());
    next.delete("ticket");
    next.delete("tproject");
    navigate(next);
  };
  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Ticket #{ticketId}
            <Link href={`/tickets/${ticketId}${projectCode ? `?project=${encodeURIComponent(projectCode)}` : ""}`} className="text-muted-foreground hover:text-foreground" aria-label="Open as page" title="Open as page">
              <Maximize2 className="size-3.5" />
            </Link>
          </SheetTitle>
          <SheetDescription>Imported historical record. Times in Africa/Cairo.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
