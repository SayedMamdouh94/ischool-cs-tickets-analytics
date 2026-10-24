import { type NextRequest } from "next/server";
import { checkViewer } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { buildCsvTemplate, buildXlsxTemplate } from "@/lib/imports/template";
import type { Settings, StatusValue, TopicMappings } from "@/lib/analytics/types";

/**
 * Import template download (.xlsx with instructions/examples, or .csv header).
 * ?project=CODE produces a project-specific workbook (Organization_ID check,
 * project details on the Instructions sheet). Administrators only.
 */
export async function GET(request: NextRequest) {
  const access = await checkViewer("admin");
  if (!access.ok) return Response.json({ error: "Administrator role required" }, { status: access.status });

  const params = request.nextUrl.searchParams;
  const format = params.get("format") === "csv" ? "csv" : "xlsx";
  const code = params.get("project");
  const date = new Date().toISOString().slice(0, 10);

  if (format === "csv") {
    return new Response(buildCsvTemplate(), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="cs-tickets-import-template${code ? `-${code}` : ""}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  const supabase = await createClient();
  const [settings, statuses, topics] = await Promise.all([
    callRpc<Settings>(supabase, "get_settings"),
    callRpc<StatusValue[]>(supabase, "get_status_values"),
    callRpc<TopicMappings>(supabase, "get_topic_mappings"),
  ]);
  if (settings.error || statuses.error || topics.error) {
    return Response.json({ error: "Could not load reference data for the template." }, { status: 500 });
  }
  const project = code ? settings.data.projects.find((p) => p.code === code && p.status === "active") : null;
  if (code && !project) return Response.json({ error: "Unknown or archived project" }, { status: 404 });

  const buffer = await buildXlsxTemplate({
    project: project ?? null,
    statuses: statuses.data.filter((s) => s.configured && s.class).map((s) => ({ status: s.status, label: s.label ?? s.status, class: s.class! })),
    topics: topics.data.topics.map((t) => t.topic),
    generatedAt: new Date(),
  });
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="cs-tickets-import-template${project ? `-${project.code}` : ""}-${date}.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
