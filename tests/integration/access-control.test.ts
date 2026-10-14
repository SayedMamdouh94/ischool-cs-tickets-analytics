import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, rpc, sql, stackReachable, userClient } from "./helpers";

const reachable = await stackReachable();

describe.skipIf(!reachable)("access control (RLS + role checks in PostgreSQL)", () => {
  let anon: SupabaseClient;
  let noRole: SupabaseClient;
  let analyst: SupabaseClient;
  let admin: SupabaseClient;
  let adminId: string;

  beforeAll(async () => {
    anon = await anonClient();
    noRole = (await userClient("it-norole@local.test", null)).client;
    analyst = (await userClient("it-analyst@local.test", "analyst")).client;
    const a = await userClient("it-admin@local.test", "admin");
    admin = a.client;
    adminId = a.userId;
  });

  afterAll(async () => {
    const db = sql();
    await db`delete from public.user_roles where user_id in (select id from auth.users where email like 'it-%@local.test') and role = 'analyst'`;
    await db.end();
  });

  it("anonymous visitors cannot read tables or call functions", async () => {
    expect((await anon.from("tickets").select("ticket_id").limit(1)).error?.code).toBe("42501");
    expect((await anon.from("projects").select("code")).error?.code).toBe("42501");
    expect((await rpc(anon, "get_grouped_metrics", { p_filters: {} })).error).not.toBeNull();
    expect((await rpc(anon, "search_tickets", {})).error).not.toBeNull();
  });

  it("authenticated users without a role see nothing", async () => {
    const t = await noRole.from("tickets").select("ticket_id").limit(5);
    expect(t.error).toBeNull();
    expect(t.data).toEqual([]);
    const p = await noRole.from("projects").select("code");
    expect(p.data).toEqual([]);
    const m = await rpc(noRole, "get_grouped_metrics", { p_filters: {} });
    expect(m.error?.code).toBe("42501");
  });

  it("analysts get aggregates and metadata but never raw text", async () => {
    const m = await rpc<{ rows: { tickets: number }[] }>(analyst, "get_grouped_metrics", { p_filters: {}, p_dimension: "none" });
    expect(m.error).toBeNull();
    expect(m.data.rows[0].tickets).toBeGreaterThan(0);

    expect((await analyst.from("tickets").select("message").limit(1)).error?.code).toBe("42501");
    expect((await analyst.from("tickets").select("note").limit(1)).error?.code).toBe("42501");
    expect((await analyst.from("tickets").select("ticket_id, topic, status").limit(1)).data?.length).toBe(1);
    expect((await analyst.from("ticket_attachments").select("url").limit(5)).data).toEqual([]);
    expect((await analyst.from("import_errors").select("raw_row").limit(5)).data).toEqual([]);

    const detail = await rpc<{ content_visible: boolean; message: string | null; attachments: unknown }>(analyst, "get_ticket_detail", { p_ticket_id: 407898 });
    expect(detail.data.content_visible).toBe(false);
    expect(detail.data.message).toBeNull();
    expect(detail.data.attachments).toBeNull();

    const search = await rpc<{ content_search: boolean; total: number }>(analyst, "search_tickets", { p_filters: {}, p_search: "غياب" });
    expect(search.data.content_search).toBe(false);
    expect(search.data.total).toBe(0); // message text is not searchable for analysts
  });

  it("analysts cannot export ticket rows, change settings or manage access", async () => {
    expect((await rpc(analyst, "export_tickets_page", { p_filters: {} })).error?.code).toBe("42501");
    expect((await rpc(analyst, "record_export", { p_kind: "tickets_metadata", p_filters: {}, p_row_count: 1 })).error?.code).toBe("42501");
    expect((await rpc(analyst, "update_threshold", { p_key: "response_hours", p_value_hours: 1 })).error?.code).toBe("42501");
    expect((await rpc(analyst, "list_app_users")).error?.code).toBe("42501");
    expect((await rpc(analyst, "set_user_role", { p_email: "it-norole@local.test", p_role: "admin" })).error?.code).toBe("42501");
    // Direct table writes are blocked by RLS / grants as well.
    const upd = await analyst.from("analytics_thresholds").update({ value_hours: 1 }).eq("key", "response_hours").select();
    expect(upd.data ?? []).toEqual([]);
    const ins = await analyst.from("user_roles").insert({ user_id: adminId, role: "analyst" });
    expect(ins.error).not.toBeNull();
  });

  it("administrators can read content, and each content view is audited", async () => {
    const db = sql();
    const [{ before }] = await db<{ before: number }[]>`select count(*)::int as before from public.audit_events where action = 'ticket.view_content'`;
    const detail = await rpc<{ content_visible: boolean; message: string }>(admin, "get_ticket_detail", { p_ticket_id: 407898 });
    expect(detail.data.content_visible).toBe(true);
    expect(detail.data.message.length).toBeGreaterThan(100);
    const [{ after }] = await db<{ after: number }[]>`select count(*)::int as after from public.audit_events where action = 'ticket.view_content'`;
    expect(after).toBe(before + 1);
    await db.end();

    const search = await rpc<{ content_search: boolean; total: number }>(admin, "search_tickets", { p_filters: {}, p_search: "غياب" });
    expect(search.data.content_search).toBe(true);
    expect(search.data.total).toBeGreaterThan(1000);

    const page = await rpc<{ ticket_id: number; message: string | null }[]>(admin, "export_tickets_page", { p_filters: {}, p_limit: 5, p_include_text: false });
    expect(page.data).toHaveLength(5);
    expect(page.data.every((r) => r.message === null)).toBe(true);
  });

  it("settings changes are validated and enforced in the database", async () => {
    expect((await rpc(admin, "update_threshold", { p_key: "response_hours", p_value_hours: -1 })).error?.code).toBe("22023");
    expect((await rpc(admin, "update_app_setting", { p_key: "date_preset_anchor", p_value: "yesterday" })).error?.code).toBe("22023");
    const ok = await rpc(admin, "update_threshold", { p_key: "response_hours", p_value_hours: 24 });
    expect(ok.error).toBeNull();
  });

  it("the last administrator cannot be removed", async () => {
    const db = sql();
    try {
      const admins = await db<{ user_id: string }[]>`select user_id from public.user_roles where role = 'admin'`;
      await expect(
        db.begin(async (tx) => {
          await tx`delete from public.user_roles where role = 'admin'`;
        }),
      ).rejects.toThrow(/last administrator/);
      const still = await db<{ n: number }[]>`select count(*)::int as n from public.user_roles where role = 'admin'`;
      expect(still[0].n).toBe(admins.length);
    } finally {
      await db.end();
    }
  });

  it("rejects malicious or malformed parameters", async () => {
    expect((await rpc(admin, "get_grouped_metrics", { p_filters: {}, p_dimension: "1; drop table tickets" })).error?.code).toBe("22023");
    const r = await rpc<{ total: number }>(admin, "search_tickets", { p_filters: {}, p_search: "%' or 1=1 --", p_sort: "ticket_id; drop table x" });
    expect(r.error).toBeNull();
    expect(r.data.total).toBe(0);
  });
});
