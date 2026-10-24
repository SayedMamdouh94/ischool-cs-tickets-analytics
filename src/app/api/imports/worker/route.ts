import { type NextRequest } from "next/server";
import { scheduleWorker, verifyWorkerSecret } from "@/lib/imports/worker";

/**
 * Background worker entry point, called by the database scheduler (pg_cron via
 * pg_net) and by the worker itself to continue long files. Not a user-facing
 * endpoint: it requires the shared bearer secret (IMPORT_WORKER_SECRET) and has
 * no user session. It only processes jobs an administrator already created.
 */
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  if (!verifyWorkerSecret(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { jobId?: unknown };
  const jobId = typeof body.jobId === "string" && UUID.test(body.jobId) ? body.jobId : undefined;
  scheduleWorker(jobId);
  return Response.json({ accepted: true }, { status: 202 });
}
