import { getViewer } from "@/lib/auth/dal";
import { getScopeCatalog } from "@/lib/analytics/queries";
import { ScopeSelector } from "./scope-selector";

/**
 * Header: which reporting cycle the dashboard shows, and how recent each
 * project's export is. Makes it explicit that figures are imported historical
 * data, not live data.
 */
export async function DataFreshness() {
  const viewer = await getViewer();
  if (!viewer?.role) return null;
  const catalog = await getScopeCatalog();
  return <ScopeSelector catalog={catalog} />;
}
