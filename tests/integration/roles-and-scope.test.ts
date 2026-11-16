import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rpc, sql, stackReachable, userClient } from "./helpers";

const reachable = await stackReachable();

/**
 * Custom roles, permissions and per-account project access, enforced in
 * PostgreSQL (the application only hides what these checks refuse).
 */
describe.skipIf(!reachable)("roles, permissions and project scope (PostgreSQL)", () => {
  const ROLES: Record<string, string[]> = {
    it_overview_only: ["page.overview"],
    it_reader: ["page.tickets", "tickets.read_content"],
    it_exporter: ["page.tickets", "export.tickets"],
    it_manager: ["page.settings", "projects.manage", "imports.manage", "categories.manage"],
  };
  const EMAILS = ["it-overview", "it-reader", "it-exporter", "it-deci", "it-demi3", "it-scoped-manager"].map((e) => `${e}@local.test`);

  let admin: SupabaseClient;
  let analyst: SupabaseClient;
  let overviewOnly: SupabaseClient;
  let reader: SupabaseClient;
  let exporter: SupabaseClient;
  let deci: SupabaseClient;
  let demi3: SupabaseClient;
  let scopedManager: SupabaseClient;
  let counts: { deci: number; demi3: number; all: number };
  let deciTicket: number;
  let demiTicket: number;

  beforeAll(async () => {
    const db = sql();
    try {
      for (const [code, perms] of Object.entries(ROLES)) {
        await db`insert into public.app_roles (code, name, permissions) values (${code}, ${code}, ${perms})
                 on conflict (code) do update set permissions = excluded.permissions`;
      }
      const rows = await db<{ program: string; code: string; n: number }[]>`
        select p.program, p.code, count(*)::int as n from public.tickets t join public.projects p on p.id = t.project_id
        where p.status <> 'draft' group by 1, 2`;
      counts = {
        deci: rows.filter((r) => r.program === "DECI").reduce((a, r) => a + r.n, 0),
        demi3: rows.find((r) => r.code === "DEMI_3RD")?.n ?? 0,
        all: rows.reduce((a, r) => a + r.n, 0),
      };
      // Source IDs that exist in exactly one project, so detail lookups are unambiguous.
      const pick = async (program: string) =>
        (
          await db<{ ticket_id: number }[]>`
            select t.ticket_id::int from public.tickets t join public.projects p on p.id = t.project_id
            where p.program = ${program} and p.status = 'active'
              and not exists (select 1 from public.tickets t2 where t2.ticket_id = t.ticket_id and t2.id <> t.id)
            order by t.ticket_id limit 1`
        )[0].ticket_id;
      deciTicket = await pick("DECI");
      demiTicket = await pick("DEMI");
    } finally {
      await db.end();
    }
    expect(counts.deci).toBeGreaterThan(0);
    expect(counts.demi3).toBeGreaterThan(0);

    admin = (await userClient("it-admin@local.test", "admin")).client;
    analyst = (await userClient("it-analyst@local.test", "analyst")).client;
    overviewOnly = (await userClient(EMAILS[0], "it_overview_only")).client;
    reader = (await userClient(EMAILS[1], "it_reader")).client;
    exporter = (await userClient(EMAILS[2], "it_exporter", { projects: ["DEMI_3RD"] })).client;
    deci = (await userClient(EMAILS[3], "analyst", { programs: ["DECI"] })).client;
    demi3 = (await userClient(EMAILS[4], "analyst", { projects: ["DEMI_3RD"] })).client;
    scopedManager = (await userClient(EMAILS[5], "it_manager", { programs: ["DECI"] })).client;
  });

  afterAll(async () => {
    const db = sql();
    try {
      await db`delete from public.user_roles where user_id in (select id from auth.users where email = any (${EMAILS}))`;
      await db`delete from public.app_roles where code like 'it\\_%'`;
    } finally {
      await db.end();
    }
  });

  it("reports the caller's role, effective permissions and scope", async () => {
    const me = await rpc<{ role: string; permissions: string[]; all_projects: boolean; programs: string[] }>(deci, "get_my_access");
    expect(me.data.role).toBe("analyst");
    expect(me.data.all_projects).toBe(false);
    expect(me.data.programs).toEqual(["DECI"]);
    expect(me.data.permissions).toContain("page.overview");

    const adminAccess = await rpc<{ permissions: string[]; all_projects: boolean }>(admin, "get_my_access");
    expect(adminAccess.data.all_projects).toBe(true);
    expect(adminAccess.data.permissions).toContain("audit.view");
  });

  it("custom roles get exactly the permissions they were given", async () => {
    const me = await rpc<{ permissions: string[] }>(overviewOnly, "get_my_access");
    expect(me.data.permissions).toEqual(["page.overview"]);

    // Aggregates stay available to any role (page access is enforced by the application).
    const m = await rpc<{ rows: { tickets: number }[] }>(overviewOnly, "get_grouped_metrics", { p_filters: {}, p_dimension: "none" });
    expect(m.error).toBeNull();
    expect(m.data.rows[0].tickets).toBe(counts.all);

    // The Ticket Explorer and every sensitive action are refused by PostgreSQL.
    expect((await rpc(overviewOnly, "search_tickets", { p_filters: {} })).error?.code).toBe("42501");
    expect((await rpc(overviewOnly, "get_ticket_detail", { p_ticket_id: deciTicket })).error?.code).toBe("42501");
    expect((await rpc(overviewOnly, "export_tickets_page", { p_filters: {} })).error?.code).toBe("42501");
    expect((await rpc(overviewOnly, "record_export", { p_kind: "aggregate_projects", p_filters: {}, p_row_count: 1 })).error?.code).toBe("42501");
    expect((await rpc(overviewOnly, "update_threshold", { p_key: "response_hours", p_value_hours: 24 })).error?.code).toBe("42501");
    expect((await rpc(overviewOnly, "get_audit_events")).error?.code).toBe("42501");
  });

  it("message text needs tickets.read_content, and every view is audited", async () => {
    const db = sql();
    const [{ before }] = await db<{ before: number }[]>`select count(*)::int as before from public.audit_events where action = 'ticket.view_content'`;
    const detail = await rpc<{ content_visible: boolean; message: string | null }>(reader, "get_ticket_detail", { p_ticket_id: deciTicket });
    expect(detail.error).toBeNull();
    expect(detail.data.content_visible).toBe(true);
    const [{ after }] = await db<{ after: number }[]>`select count(*)::int as after from public.audit_events where action = 'ticket.view_content'`;
    await db.end();
    expect(after).toBe(before + 1);

    const search = await rpc<{ content_search: boolean }>(reader, "search_tickets", { p_filters: {}, p_search: "غياب" });
    expect(search.data.content_search).toBe(true);

    // Without the permission (analyst): metadata only.
    const meta = await rpc<{ content_visible: boolean; message: string | null }>(analyst, "get_ticket_detail", { p_ticket_id: deciTicket });
    expect(meta.data.content_visible).toBe(false);
    expect(meta.data.message).toBeNull();
  });

  it("ticket exports: metadata with export.tickets, message text also needs tickets.read_content", async () => {
    const page = await rpc<{ project: string }[]>(exporter, "export_tickets_page", { p_filters: {}, p_limit: 1000, p_include_text: false });
    expect(page.error).toBeNull();
    expect(page.data).toHaveLength(Math.min(1000, counts.demi3));
    // Exports follow the account's project access (this account: DEMI_3RD only).
    expect(new Set(page.data.map((r) => r.project)).size).toBe(1);
    expect((await rpc(exporter, "export_tickets_page", { p_filters: {}, p_limit: 5, p_include_text: true })).error?.code).toBe("42501");
    expect((await rpc(exporter, "record_export", { p_kind: "tickets_metadata", p_filters: {}, p_row_count: 5 })).error).toBeNull();
    expect((await rpc(exporter, "record_export", { p_kind: "tickets_with_text", p_filters: {}, p_row_count: 5 })).error?.code).toBe("42501");
  });

  it("a program grant limits every analytics function to that program's projects", async () => {
    const byProject = await rpc<{ rows: { key: string; tickets: number }[] }>(deci, "get_grouped_metrics", { p_filters: {}, p_dimension: "project" });
    expect(byProject.data.rows.map((r) => r.key).every((k) => k.startsWith("DECI"))).toBe(true);
    expect(byProject.data.rows.reduce((a, r) => a + r.tickets, 0)).toBe(counts.deci);

    // Asking for another program's project explicitly returns nothing.
    const other = await rpc<{ rows: { tickets: number }[] }>(deci, "get_grouped_metrics", { p_filters: { projects: ["DEMI_3RD"] }, p_dimension: "none" });
    expect(other.data.rows[0]?.tickets ?? 0).toBe(0);

    const search = await rpc<{ total: number }>(deci, "search_tickets", { p_filters: {} });
    expect(search.data.total).toBe(counts.deci);
    const dq = await rpc<{ total: number }>(deci, "get_data_quality", { p_filters: {} });
    expect(dq.data.total).toBe(counts.deci);

    const catalog = await rpc<{ projects: { code: string }[] }[]>(deci, "get_scope_catalog");
    const catalogCodes = catalog.data.flatMap((c) => c.projects.map((p) => p.code));
    expect(catalogCodes.length).toBeGreaterThan(0);
    expect(catalogCodes.every((c) => c.startsWith("DECI"))).toBe(true);

    const options = await rpc<{ projects: { code: string }[] }>(deci, "get_filter_options", { p_scope: {} });
    expect(options.data.projects.every((p) => p.code.startsWith("DECI"))).toBe(true);

    const settings = await rpc<{ projects: { code: string }[] }>(deci, "get_settings");
    expect(settings.data.projects.every((p) => p.code.startsWith("DECI"))).toBe(true);

    const runs = await rpc<{ project: string | null }[]>(deci, "get_import_runs", { p_limit: 500 });
    expect(runs.data.every((r) => r.project?.startsWith("DECI"))).toBe(true);

    expect((await rpc(deci, "get_ticket_detail", { p_ticket_id: deciTicket })).data).not.toBeNull();
    expect((await rpc(deci, "get_ticket_detail", { p_ticket_id: demiTicket })).data).toBeNull();
    expect((await rpc(deci, "get_project_history", { p_code: "DEMI_3RD" })).data).toBeNull();
  });

  it("project scope also applies to direct table reads (RLS)", async () => {
    const tickets = await deci.from("tickets").select("ticket_id", { count: "exact", head: true });
    expect(tickets.error).toBeNull();
    expect(tickets.count).toBe(counts.deci);
    const projects = await deci.from("projects").select("code");
    expect((projects.data ?? []).map((p) => p.code).every((c) => c.startsWith("DECI"))).toBe(true);
    const runs = await deci.from("import_runs").select("id, project_id");
    const visible = new Set(((await deci.from("projects").select("id")).data ?? []).map((p) => p.id));
    expect((runs.data ?? []).every((r) => visible.has(r.project_id))).toBe(true);
  });

  it("a project grant limits the account to that single project", async () => {
    const byProject = await rpc<{ rows: { key: string; tickets: number }[] }>(demi3, "get_grouped_metrics", { p_filters: {}, p_dimension: "project" });
    expect(byProject.data.rows.map((r) => r.key)).toEqual(["DEMI_3RD"]);
    expect(byProject.data.rows[0].tickets).toBe(counts.demi3);
  });

  it("cross-project management permissions only apply with access to all projects", async () => {
    const me = await rpc<{ permissions: string[] }>(scopedManager, "get_my_access");
    expect(me.data.permissions).toEqual(["page.settings", "categories.manage"]);
    expect((await rpc(scopedManager, "create_reporting_cycle", { p_cycle: { code: "IT_NEVER", name: "never" } })).error?.code).toBe("42501");
    expect((await rpc(scopedManager, "get_import_jobs", { p_limit: 5 })).error?.code).toBe("42501");
    expect((await scopedManager.from("import_jobs").select("id")).data).toEqual([]);
  });

  it("only administrators manage roles and access", async () => {
    for (const client of [analyst, scopedManager]) {
      expect((await rpc(client, "list_app_roles")).error?.code).toBe("42501");
      expect((await rpc(client, "upsert_app_role", { p_code: "it_x", p_name: "x", p_description: null, p_permissions: [], p_is_new: true })).error?.code).toBe("42501");
      expect((await rpc(client, "delete_app_role", { p_code: "it_reader" })).error?.code).toBe("42501");
      expect((await rpc(client, "set_user_access", { p_email: EMAILS[0], p_role: "admin" })).error?.code).toBe("42501");
    }
    // No direct writes either.
    expect((await analyst.from("app_roles").insert({ code: "it_y", name: "y" })).error).not.toBeNull();
    expect((await analyst.from("user_program_access").insert({ user_id: "00000000-0000-0000-0000-000000000000", program: "DEMI" })).error).not.toBeNull();
  });

  it("roles are validated, built-in roles are protected, and changes are audited", async () => {
    const create = () => rpc(admin, "upsert_app_role", { p_code: "it_new", p_name: "IT new role", p_description: "test", p_permissions: ["page.trends", "page.trends", "audit.view"], p_is_new: true });
    const created = await create();
    expect(created.error).toBeNull();
    expect((created.data as { permissions: string[] }).permissions).toEqual(["page.trends", "audit.view"]);
    expect((await create()).error?.code).toBe("23505");

    expect((await rpc(admin, "upsert_app_role", { p_code: "admin", p_name: "Administrator", p_description: null, p_permissions: [] })).error?.code).toBe("22023");
    expect((await rpc(admin, "upsert_app_role", { p_code: "it_new", p_name: "IT new role", p_description: null, p_permissions: ["page.nope"] })).error?.code).toBe("22023");
    expect((await rpc(admin, "delete_app_role", { p_code: "analyst" })).error?.code).toBe("22023");
    expect((await rpc(admin, "delete_app_role", { p_code: "it_reader" })).error?.code).toBe("23503"); // still assigned
    expect((await rpc(admin, "delete_app_role", { p_code: "it_new" })).error).toBeNull();

    const db = sql();
    const audit = await db<{ action: string }[]>`
      select action from public.audit_events where details ->> 'role' = 'it_new' order by id desc limit 2`;
    await db.end();
    expect(audit.map((a) => a.action)).toEqual(["access.role_deleted", "access.role_created"]);
  });

  it("access changes are validated and replace the previous scope atomically", async () => {
    const set = (args: Record<string, unknown>) => rpc(admin, "set_user_access", { p_email: EMAILS[4], ...args });
    expect((await set({ p_role: "admin", p_all_projects: false, p_programs: ["DECI"] })).error?.code).toBe("22023");
    expect((await set({ p_role: "analyst", p_all_projects: false })).error?.code).toBe("22023");
    expect((await set({ p_role: "analyst", p_all_projects: false, p_programs: ["NOPE"] })).error?.code).toBe("22023");
    expect((await set({ p_role: "analyst", p_all_projects: false, p_project_codes: ["NOPE_1"] })).error?.code).toBe("22023");
    expect((await set({ p_role: "it_missing" })).error?.code).toBe("22023");

    expect((await set({ p_role: "analyst", p_all_projects: false, p_programs: ["deci"] })).error).toBeNull();
    const users = await rpc<{ email: string; all_projects: boolean; programs: string[]; project_codes: string[] }[]>(admin, "list_app_users");
    const row = users.data.find((u) => u.email === EMAILS[4])!;
    expect(row).toMatchObject({ all_projects: false, programs: ["DECI"], project_codes: [] });

    // Restore the fixture scope for other tests.
    expect((await set({ p_role: "analyst", p_all_projects: false, p_project_codes: ["DEMI_3RD"] })).error).toBeNull();
  });

  it("only access management still requires the Administrator role itself", async () => {
    const db = sql();
    const rows = await db<{ fn: string }[]>`
      select p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosrc like '%require_role(''admin'')%' order by 1`;
    await db.end();
    expect(rows.map((r) => r.fn)).toEqual([
      "delete_app_role",
      "list_app_roles",
      "list_app_users",
      "revoke_user_role",
      "set_user_access",
      "set_user_role",
      "upsert_app_role",
    ]);
  });
});
