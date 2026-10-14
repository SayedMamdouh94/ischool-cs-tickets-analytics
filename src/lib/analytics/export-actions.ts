"use server";

import { z } from "zod";
import { requireViewer } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";

const schema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  rows: z.number().int().min(0).max(1_000_000),
  path: z.string().max(2000),
});

/** Audits a client-side download of aggregated data (no ticket-level content). */
export async function recordAggregateExport(input: { kind: string; rows: number; path: string }): Promise<void> {
  await requireViewer("analyst");
  const parsed = schema.safeParse(input);
  if (!parsed.success) return;
  const supabase = await createClient();
  await callRpc(supabase, "record_export", {
    p_kind: `aggregate_${parsed.data.kind}`.slice(0, 60),
    p_filters: { path: parsed.data.path },
    p_row_count: parsed.data.rows,
  });
}
