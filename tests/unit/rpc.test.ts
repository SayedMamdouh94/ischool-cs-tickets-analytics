import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc } from "@/lib/supabase/rpc";

describe("callRpc", () => {
  it("invokes rpc as a method (keeps `this`), passing name and arguments", async () => {
    class FakeClient {
      rest = { calls: [] as unknown[] };
      async rpc(fn: string, args: Record<string, unknown>) {
        this.rest.calls.push([fn, args]); // throws if `this` was lost
        return { data: { ok: true }, error: null };
      }
    }
    const client = new FakeClient();
    const result = await callRpc<{ ok: boolean }>(client as unknown as SupabaseClient, "export_tickets_page", { p_limit: 1 });
    expect(result).toEqual({ data: { ok: true }, error: null });
    expect(client.rest.calls).toEqual([["export_tickets_page", { p_limit: 1 }]]);
  });
});
