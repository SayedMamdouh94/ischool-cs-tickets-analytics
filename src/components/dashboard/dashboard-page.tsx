import { Suspense } from "react";
import { PageHeader } from "./page-header";
import { FilterSection } from "./filter-section";
import { FilterBarSkeleton, PageSkeleton } from "./states";
import { PendingContent } from "@/components/filters/filter-transition";
import type { FilterKey } from "@/components/filters/filter-bar";
import type { SearchParamsRecord } from "@/lib/filters/schema";

/**
 * Standard page frame: header, the global filter row, and the page content
 * streamed behind a Suspense boundary (Cache Components: request data such as
 * cookies and searchParams is only read inside boundaries).
 */
export function DashboardPage({
  title,
  description,
  searchParams,
  actions,
  filterKeys,
  showFilters = true,
  fallback,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  searchParams: Promise<SearchParamsRecord>;
  actions?: React.ReactNode;
  filterKeys?: FilterKey[];
  showFilters?: boolean;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5">
      <PageHeader title={title} description={description} actions={actions} />
      {showFilters && (
        <Suspense fallback={<FilterBarSkeleton />}>
          <FilterSection searchParams={searchParams} keys={filterKeys} />
        </Suspense>
      )}
      <PendingContent>
        <Suspense fallback={fallback ?? <PageSkeleton />}>{children}</Suspense>
      </PendingContent>
    </div>
  );
}
