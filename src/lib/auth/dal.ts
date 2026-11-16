import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { normalizePermissions, type Permission } from "./permissions";

/** Role code from public.app_roles ('admin', 'analyst' or a custom role). */
export type AppRole = string;

export interface Viewer {
  userId: string;
  email: string | null;
  role: AppRole | null;
  roleName: string | null;
  isAdmin: boolean;
  /** Effective permissions, as computed by PostgreSQL (private.current_permissions). */
  permissions: Permission[];
  allProjects: boolean;
  programs: string[];
  projectCodes: string[];
}

export type RoleViewer = Viewer & { role: AppRole };

interface MyAccess {
  role?: string | null;
  role_name?: string | null;
  permissions?: unknown[] | null;
  all_projects?: boolean | null;
  programs?: unknown[] | null;
  project_codes?: unknown[] | null;
}

const strings = (v: unknown[] | null | undefined) => (v ?? []).filter((x): x is string => typeof x === "string");

/**
 * Data Access Layer: resolves the current user from a verified JWT
 * (getClaims validates signature and expiry) and the role, permissions and
 * project scope from the database. Memoized per request.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;

  const { data: access } = await callRpc<MyAccess | null>(supabase, "get_my_access");
  const role = typeof access?.role === "string" && access.role ? access.role : null;
  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    role,
    roleName: role ? (access?.role_name ?? role) : null,
    isAdmin: role === "admin",
    permissions: role ? normalizePermissions(access?.permissions ?? []) : [],
    allProjects: Boolean(role && access?.all_projects),
    programs: strings(access?.programs),
    projectCodes: strings(access?.project_codes),
  };
});

/**
 * Redirects unless the viewer is signed in and holds a role.
 * `"admin"` additionally requires the Administrator role (user and role management).
 */
export async function requireViewer(minRole: "analyst" | "admin" = "analyst"): Promise<RoleViewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (!viewer.role) redirect("/no-access");
  if (minRole === "admin" && !viewer.isAdmin) redirect("/no-access?reason=admin");
  return viewer as RoleViewer;
}

/** Redirects unless the viewer's role grants `permission`. */
export async function requirePermission(permission: Permission): Promise<RoleViewer> {
  const viewer = await requireViewer();
  if (!viewer.permissions.includes(permission)) redirect("/no-access?reason=permission");
  return viewer;
}

type Check = { ok: true; viewer: RoleViewer } | { ok: false; status: 401 | 403 };

/** Non-redirecting variant for Route Handlers. */
export async function checkViewer(minRole: "analyst" | "admin" = "analyst"): Promise<Check> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, status: 401 };
  if (!viewer.role) return { ok: false, status: 403 };
  if (minRole === "admin" && !viewer.isAdmin) return { ok: false, status: 403 };
  return { ok: true, viewer: viewer as RoleViewer };
}

/** Non-redirecting permission check for Route Handlers. */
export async function checkPermission(...permissions: Permission[]): Promise<Check> {
  const access = await checkViewer();
  if (!access.ok) return access;
  if (!permissions.every((p) => access.viewer.permissions.includes(p))) return { ok: false, status: 403 };
  return access;
}
