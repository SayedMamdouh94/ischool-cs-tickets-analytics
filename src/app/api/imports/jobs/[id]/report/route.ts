import { checkViewer } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { validationReportCsv, type ReportIssue } from "@/lib/imports/report";
import type { ImportJobDetail } from "@/lib/imports/types";

/** Validation report (CSV): every finding with row number, column and explanation. Administrators only. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 5000;

export async function GET(_request: Request, ctx: RouteContext<"/api/imports/jobs/[id]/report">) {
  const access = await checkViewer("admin");
  if (!access.ok) return Response.json({ error: "Administrator role required" }, { status: access.status });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "Not found" }, { status: 404 });

  const supabase = await createClient();
  const { data: detail } = await callRpc<ImportJobDetail | null>(supabase, "get_import_job", { p_job_id: id });
  if (!detail) return Response.json({ error: "Not found" }, { status: 404 });

  const issues: ReportIssue[] = [];
  for (let offset = 0; offset < 200_000; offset += PAGE) {
    const { data, error } = await callRpc<{ total: number; issues: ReportIssue[] }>(supabase, "get_import_job_issues", {
      p_job_id: id,
      p_severity: null,
      p_limit: PAGE,
      p_offset: offset,
    });
    if (error) return Response.json({ error: error.message }, { status: 500 });
    issues.push(...data.issues);
    if (data.issues.length < PAGE) break;
  }

  // Findings counted in the summary but not stored one by one (very frequent warnings are capped).
  const listed = new Map<string, number>();
  for (const i of issues) listed.set(i.code, (listed.get(i.code) ?? 0) + 1);
  const byCode = (detail.job.validation_summary as { by_code?: Record<string, { count: number }> }).by_code ?? {};
  const omitted = Object.fromEntries(Object.entries(byCode).map(([code, v]) => [code, Math.max(0, v.count - (listed.get(code) ?? 0))]));

  const csv = validationReportCsv(issues, { filename: detail.job.original_filename, generatedAt: new Date(), omitted });
  const base = detail.job.original_filename.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").slice(0, 80) || "import";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="validation-report-${base}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
