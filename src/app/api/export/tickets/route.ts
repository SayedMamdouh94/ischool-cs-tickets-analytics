import { type NextRequest } from "next/server";
import { checkViewer } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { getFilterOptions, getSettings } from "@/lib/analytics/queries";
import { parseFilters, resolveDateRange, toRpcFilters, toRpcScope } from "@/lib/filters/schema";
import { csvEscape } from "@/lib/table-data";
import { callRpc } from "@/lib/supabase/rpc";

/**
 * Filtered ticket export (CSV). Administrators only — enforced here and again
 * by export_tickets_page() in PostgreSQL. Streams keyset-paginated pages of
 * 1,000 rows so large selections never sit in memory, and records an audit event.
 */
const COLUMNS = [
  "ticket_id",
  "project",
  "organization_id",
  "topic",
  "status",
  "department",
  "owner_type",
  "owner_id",
  "created_at",
  "responded_at",
  "resolved_at",
  "recorded_response_hours",
  "resolution_hours",
  "responder_name",
  "resolved_by",
  "response_kind",
  "sub_topic",
  "session_ref",
  "lesson_name",
  "category",
  "subcategory",
] as const;
const TEXT_COLUMNS = ["message", "response", "note"] as const;
const MAX_ROWS = 200_000;

export async function GET(request: NextRequest) {
  const access = await checkViewer("admin");
  if (!access.ok) {
    return Response.json({ error: access.status === 401 ? "Authentication required" : "Administrator role required" }, { status: access.status });
  }

  const params = request.nextUrl.searchParams;
  const includeText = params.get("include_text") === "1";
  const filters = parseFilters(params);
  const [options, settings] = await Promise.all([getFilterOptions(toRpcScope(filters)), getSettings()]);
  const range = resolveDateRange(filters, { datasetMax: options.date_range.max, anchor: settings.app.date_preset_anchor === "today" ? "today" : "dataset_end" });
  const rpcFilters = toRpcFilters(filters, range);
  const supabase = await createClient();
  const call = (fn: string, args: Record<string, unknown>) => callRpc<unknown>(supabase, fn, args);

  // Fail fast (and with a proper status) if the first page is refused.
  const first = await call("export_tickets_page", { p_filters: rpcFilters, p_after_pk: 0, p_limit: 1000, p_include_text: includeText });
  if (first.error) return Response.json({ error: first.error.message }, { status: 403 });

  const columns = includeText ? [...COLUMNS, ...TEXT_COLUMNS] : [...COLUMNS];
  const encoder = new TextEncoder();
  let total = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`﻿${columns.join(",")}\r\n`));
      let page = (first.data as Record<string, unknown>[]) ?? [];
      try {
        while (page.length > 0 && total < MAX_ROWS) {
          const lines = page.map((row) => columns.map((c) => csvEscape((row[c] ?? null) as string | number | null)).join(",")).join("\r\n");
          controller.enqueue(encoder.encode(`${lines}\r\n`));
          total += page.length;
          if (page.length < 1000) break;
          // Keyset on the internal key: source ticket IDs may repeat across projects.
          const after = Number(page[page.length - 1]._pk);
          const next = await call("export_tickets_page", { p_filters: rpcFilters, p_after_pk: after, p_limit: 1000, p_include_text: includeText });
          if (next.error) throw new Error(next.error.message);
          page = (next.data as Record<string, unknown>[]) ?? [];
        }
        await call("record_export", { p_kind: includeText ? "tickets_with_text" : "tickets_metadata", p_filters: rpcFilters, p_row_count: total });
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const stamp = (options.latest_import.data_as_of ?? "").slice(0, 10) || "export";
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tickets${includeText ? "-with-text" : ""}-${stamp}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
