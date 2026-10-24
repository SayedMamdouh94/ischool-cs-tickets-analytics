import { checkViewer } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { scheduleWorker } from "@/lib/imports/worker";
import type { ImportJobDetail } from "@/lib/imports/types";

/**
 * Job status for the progress view (administrators only, polled every few
 * seconds). If a job that needs work has no live worker, this request starts
 * one — so an open browser tab keeps an import moving even without pg_cron.
 */
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, ctx: RouteContext<"/api/imports/jobs/[id]">) {
  const access = await checkViewer("admin");
  if (!access.ok) return Response.json({ error: "Administrator role required" }, { status: access.status });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await callRpc<ImportJobDetail | null>(await createClient(), "get_import_job", { p_job_id: id });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "Not found" }, { status: 404 });

  const job = data.job;
  const needsWork = job.status === "uploaded" || job.status === "validating" || job.status === "importing";
  const leaseFree = !job.lease_expires_at || Date.parse(job.lease_expires_at) < Date.parse(data.now);
  if (needsWork && leaseFree) scheduleWorker(id);

  return Response.json(data, { headers: { "Cache-Control": "private, no-store" } });
}
