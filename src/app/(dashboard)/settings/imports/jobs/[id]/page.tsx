import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { PageSkeleton } from "@/components/dashboard/states";
import { JobMonitor } from "@/components/settings/job-monitor";
import { requireViewer } from "@/lib/auth/dal";
import { getImportJob, getImportJobIssues } from "@/lib/analytics/queries";

export const metadata: Metadata = { title: "Import" };

/** Server actions on this page (confirm, retry) continue the import after responding. */
export const maxDuration = 60;

export default function ImportJobPage({ params }: PageProps<"/settings/imports/jobs/[id]">) {
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5">
      <Link href="/settings?tab=imports" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Settings & Imports
      </Link>
      <Suspense fallback={<PageSkeleton />}>
        <JobContent params={params} />
      </Suspense>
    </div>
  );
}

async function JobContent({ params }: { params: Promise<{ id: string }> }) {
  await requireViewer("admin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [detail, issues] = await Promise.all([getImportJob(id), getImportJobIssues(id)]);
  if (!detail) notFound();
  return (
    <>
      <PageHeader title="Import" description="Upload → validation → your confirmation → background import. Every step is recorded." />
      <JobMonitor initial={detail} issues={issues.issues} issuesTotal={issues.total} />
    </>
  );
}
