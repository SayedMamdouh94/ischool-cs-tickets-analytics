import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";

export type AppRole = "admin" | "analyst";

export interface Viewer {
  userId: string;
  email: string | null;
  role: AppRole | null;
}

/**
 * Data Access Layer: resolves the current user from a verified JWT
 * (getClaims validates signature and expiry) and the application role from
 * the database. Memoized per request.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;

  const { data: access } = await callRpc<{ role?: string | null } | null>(supabase, "get_my_access");
  const role = access?.role;
  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    role: role === "admin" || role === "analyst" ? role : null,
  };
});

/** Redirects unless the viewer is signed in and holds at least `minRole`. */
export async function requireViewer(minRole: AppRole = "analyst"): Promise<Viewer & { role: AppRole }> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (!viewer.role) redirect("/no-access");
  if (minRole === "admin" && viewer.role !== "admin") redirect("/no-access?reason=admin");
  return viewer as Viewer & { role: AppRole };
}

/** Non-redirecting variant for Route Handlers. */
export async function checkViewer(minRole: AppRole = "analyst"): Promise<
  { ok: true; viewer: Viewer & { role: AppRole } } | { ok: false; status: 401 | 403 }
> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, status: 401 };
  if (!viewer.role) return { ok: false, status: 403 };
  if (minRole === "admin" && viewer.role !== "admin") return { ok: false, status: 403 };
  return { ok: true, viewer: viewer as Viewer & { role: AppRole } };
}
