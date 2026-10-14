import { FilterBar, type FilterKey } from "@/components/filters/filter-bar";
import { resolveFilterContext } from "@/lib/analytics/queries";
import { requireViewer } from "@/lib/auth/dal";
import type { SearchParamsRecord } from "@/lib/filters/schema";

/** Server wrapper: loads filter options (from the database) for the client filter bar. */
export async function FilterSection({ searchParams, keys }: { searchParams: Promise<SearchParamsRecord>; keys?: FilterKey[] }) {
  await requireViewer();
  const ctx = await resolveFilterContext(await searchParams);
  return <FilterBar options={ctx.options} range={ctx.range} anchor={ctx.anchor} keys={keys} />;
}
