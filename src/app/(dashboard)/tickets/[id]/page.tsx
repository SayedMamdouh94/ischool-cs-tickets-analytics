import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { AmbiguousTicketChoice, TicketDetailView } from "@/components/tickets/ticket-detail";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { requireViewer } from "@/lib/auth/dal";
import { getTicketDetail } from "@/lib/analytics/queries";

export const metadata: Metadata = { title: "Ticket" };

export default function TicketPage({ params, searchParams }: PageProps<"/tickets/[id]">) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <Link href="/tickets" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Ticket Explorer
      </Link>
      <Suspense fallback={<Skeleton className="h-[520px] w-full" />}>
        <TicketContent params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function TicketContent({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireViewer();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^\d{1,18}$/.test(id)) notFound();
  const project = typeof sp.project === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(sp.project) ? sp.project : null;
  const ticket = await getTicketDetail(Number(id), project);
  if (!ticket) notFound();
  if (ticket.ambiguous) {
    return (
      <>
        <PageHeader title={`Ticket #${ticket.ticket_id}`} description="This ticket number exists in more than one project." />
        <AmbiguousTicketChoice ticket={ticket} asPage />
      </>
    );
  }
  return (
    <>
      <PageHeader title={`Ticket #${ticket.ticket_id}`} description="Imported historical record. Times in Africa/Cairo." />
      <Card className="shadow-xs">
        <CardContent className="p-5">
          <TicketDetailView ticket={ticket} />
        </CardContent>
      </Card>
    </>
  );
}
