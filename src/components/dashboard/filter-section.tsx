import { FilterBar, type FilterKey } from "@/components/filters/filter-bar";
import { resolveFilterContext } from "@/lib/analytics/queries";
import { requireViewer } from "@/lib/auth/dal";
import { scopeSummary } from "@/lib/auth/permissions";
import type { SearchParamsRecord } from "@/lib/filters/schema";
import { ScopeNotices } from "./scope-notices";

/** Server wrapper: loads filter options (from the database) for the client filter bar. */
export async function FilterSection({ searchParams, keys }: { searchParams: Promise<SearchParamsRecord>; keys?: FilterKey[] }) {
  const viewer = await requireViewer();
  const ctx = await resolveFilterContext(await searchParams);
  return (
    <div className="flex flex-col gap-2">
      <FilterBar options={ctx.options} range={ctx.range} anchor={ctx.anchor} keys={keys} />
      <ScopeNotices
        options={ctx.options}
        canManageProjects={viewer.permissions.includes("projects.manage")}
        restrictedTo={viewer.allProjects ? null : scopeSummary({ allProjects: false, programs: viewer.programs, projectCodes: viewer.projectCodes })}
      />
    </div>
  );
}
