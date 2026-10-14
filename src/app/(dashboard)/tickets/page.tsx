import type { Metadata } from "next";
import { Suspense } from "react";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { PageActions } from "@/components/dashboard/page-actions";
import { TicketDetailView } from "@/components/tickets/ticket-detail";
import { TicketDrawer } from "@/components/tickets/ticket-drawer";
import { TicketSearchBox, TicketTable } from "@/components/tickets/ticket-table";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewer } from "@/lib/auth/dal";
import { getTicketDetail, resolveFilterContext, searchTickets } from "@/lib/analytics/queries";
import type { SearchParamsRecord } from "@/lib/filters/schema";
import { pickInt, pickParam, pickString } from "@/lib/search-params";

export const metadata: Metadata = { title: "Ticket Explorer" };

const SORTS = [
  "ticket_id",
  "project",
  "topic",
  "status",
  "owner_id",
  "created_at",
  "responded_at",
  "resolved_at",
  "responder_name",
  "resolved_by",
  "response_seconds",
  "resolution_seconds",
] as const;

export default function TicketsPage({ searchParams }: PageProps<"/tickets">) {
  return (
    <DashboardPage
      title="Ticket Explorer"
      description="Search, sort and page through individual tickets. Only one page of rows is loaded at a time; message content is visible to administrators only."
      searchParams={searchParams}
      actions={<PageActions />}
      fallback={<Skeleton className="h-[480px] w-full" />}
    >
      <TicketsContent searchParams={searchParams} />
    </DashboardPage>
  );
}

async function TicketsContent({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const ctx = await resolveFilterContext(sp);
  const result = await searchTickets(ctx.rpc, {
    search: pickString(sp, "q"),
    sort: pickParam(sp, "sort", SORTS, "created_at"),
    dir: pickParam(sp, "dir", ["asc", "desc"] as const, "desc"),
    page: pickInt(sp, "page", 1, 1, 100_000),
    pageSize: pickInt(sp, "size", 25, 10, 100),
  });
  const ticketParam = pickString(sp, "ticket", 18);
  const ticketId = ticketParam && /^\d+$/.test(ticketParam) ? Number(ticketParam) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TicketSearchBox contentSearch={viewer.role === "admin"} />
        {!result.content_search && <p className="text-xs text-muted-foreground">Message text search is available to administrators.</p>}
      </div>
      <TicketTable result={result} />
      {ticketId !== null && (
        <TicketDrawer ticketId={ticketId}>
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <DrawerDetail ticketId={ticketId} />
          </Suspense>
        </TicketDrawer>
      )}
    </div>
  );
}

async function DrawerDetail({ ticketId }: { ticketId: number }) {
  const ticket = await getTicketDetail(ticketId);
  if (!ticket) return <p className="text-sm text-muted-foreground">Ticket not found.</p>;
  return <TicketDetailView ticket={ticket} />;
}
