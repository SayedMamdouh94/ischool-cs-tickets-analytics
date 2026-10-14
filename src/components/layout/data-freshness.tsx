import { Database } from "lucide-react";
import { getViewer } from "@/lib/auth/dal";
import { getFilterOptions } from "@/lib/analytics/queries";
import { fmtDateTime } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Makes it explicit that the dashboard shows imported historical data, not live data. */
export async function DataFreshness() {
  const viewer = await getViewer();
  if (!viewer?.role) return null;
  const options = await getFilterOptions();
  const asOf = options.latest_import.data_as_of;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground md:inline-flex">
          <Database className="size-3.5" aria-hidden />
          Historical export · data as of {fmtDateTime(asOf)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Figures come from imported CSV exports, not the live ticketing system. Latest import completed{" "}
        {fmtDateTime(options.latest_import.completed_at)} (Africa/Cairo). Statuses reflect the export snapshot.
      </TooltipContent>
    </Tooltip>
  );
}
