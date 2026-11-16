// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AppRoleSummary, AppUser } from "@/lib/analytics/types";

const actions = vi.hoisted(() => ({
  saveRole: vi.fn(async () => ({ ok: true, message: "saved" })),
  deleteRole: vi.fn(async () => ({ ok: true, message: "deleted" })),
  grantAccess: vi.fn(async () => ({ ok: true, message: "granted" })),
  updateAccess: vi.fn(async () => ({ ok: true, message: "updated" })),
  revokeAccess: vi.fn(async () => ({ ok: true, message: "revoked" })),
}));
vi.mock("@/lib/settings/access-actions", () => actions);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Radix checkboxes measure themselves; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const { AccessPanel } = await import("@/components/settings/access-panel");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ROLES: AppRoleSummary[] = [
  { code: "admin", name: "Administrator", description: null, permissions: ["page.overview", "audit.view"], is_system: true, editable: false, users: 1, updated_at: "" },
  { code: "analyst", name: "Analyst", description: null, permissions: ["page.overview", "export.aggregate"], is_system: true, editable: true, users: 0, updated_at: "" },
  { code: "lead", name: "Support Lead", description: null, permissions: ["page.overview", "projects.manage"], is_system: false, editable: true, users: 2, updated_at: "" },
];
const user = (over: Partial<AppUser>): AppUser => ({
  user_id: "u1",
  email: "a@x.test",
  role: "analyst",
  role_name: "Analyst",
  all_projects: true,
  programs: [],
  project_codes: [],
  created_at: "",
  last_sign_in_at: null,
  email_confirmed_at: "2026-01-01",
  invited_at: null,
  ...over,
});
const USERS = [
  user({ user_id: "me", email: "me@x.test", role: "admin", role_name: "Administrator" }),
  user({ user_id: "u2", email: "lead@x.test", role: "lead", role_name: "Support Lead", all_projects: false, programs: ["DECI"], project_codes: ["DEMI_3RD"] }),
];
const PROJECTS = [
  { code: "DECI_4TH", name: "DECI — 4th", program: "DECI", status: "active", cycle_name: "2026" },
  { code: "DEMI_3RD", name: "DEMI — 3rd", program: "DEMI", status: "active", cycle_name: "2026" },
];

function renderPanel() {
  render(<AccessPanel users={USERS} roles={ROLES} projects={PROJECTS} currentUserId="me" canInvite />);
}

describe("AccessPanel — accounts", () => {
  it("summarises each account's role and project access, and never offers to edit yourself", () => {
    renderPanel();
    const lead = screen.getByText("lead@x.test").closest("tr")!;
    expect(within(lead).getByText("DECI (all), DEMI_3RD")).toBeTruthy();
    expect(within(lead).getByRole("button", { name: /edit access/i })).toBeTruthy();
    const me = screen.getByText("me@x.test").closest("tr")!;
    expect(within(me).queryByRole("button")).toBeNull();
  });

  it("grants a role limited to the ticked program", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /add user/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "new@x.test" } });
    fireEvent.click(within(dialog).getByLabelText(/only selected programs and projects/i));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /DECI — all projects/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: /grant access/i }));
    await waitFor(() => expect(actions.grantAccess).toHaveBeenCalledTimes(1));
    expect(actions.grantAccess).toHaveBeenCalledWith({ email: "new@x.test", role: "analyst", allProjects: false, programs: ["DECI"], projectCodes: [] });
  });

  it("edits an existing account starting from its current scope, and warns about all-projects-only permissions", async () => {
    renderPanel();
    fireEvent.click(within(screen.getByText("lead@x.test").closest("tr")!).getByRole("button", { name: /edit access/i }));
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText("Email") as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByText(/only apply to accounts with access to all projects/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /save access/i }));
    await waitFor(() => expect(actions.updateAccess).toHaveBeenCalledTimes(1));
    expect(actions.updateAccess).toHaveBeenCalledWith({ email: "lead@x.test", role: "lead", allProjects: false, programs: ["DECI"], projectCodes: ["DEMI_3RD"] });
  });
});

describe("AccessPanel — roles", () => {
  it("locks the Administrator role and only allows deleting unused custom roles", () => {
    renderPanel();
    const adminRow = screen.getAllByText("Administrator").map((e) => e.closest("tr")!).find((r) => within(r).queryByText("admin"))!;
    expect(within(adminRow).getByText("Built in")).toBeTruthy();
    expect(within(adminRow).queryByRole("button", { name: /delete/i })).toBeNull();
    const leadRow = within(screen.getByText("lead").closest("tr")!);
    expect((leadRow.getByRole("button", { name: /delete/i }) as HTMLButtonElement).disabled).toBe(true); // 2 accounts
  });

  it("creates a role with a code derived from its name and the ticked permissions", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /new role/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Quality Team 2" } });
    expect((within(dialog).getByLabelText("Code") as HTMLInputElement).value).toBe("quality_team_2");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /executive overview/i }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /view audit log/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: /create role/i }));
    await waitFor(() => expect(actions.saveRole).toHaveBeenCalledTimes(1));
    expect(actions.saveRole).toHaveBeenCalledWith({ code: "quality_team_2", name: "Quality Team 2", description: "", permissions: ["page.overview", "audit.view"], isNew: true });
  });
});
