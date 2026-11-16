"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireViewer } from "@/lib/auth/dal";
import { PERMISSION_KEYS } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { createAdminClient, hasAdminCredentials } from "@/lib/supabase/admin";
import { siteUrl } from "@/lib/env";
import type { ActionResult } from "./actions";

/**
 * User and role management. Administrators only: re-verified here AND by the
 * SQL functions in PostgreSQL, which validate permissions and project scope
 * and audit every change.
 */
async function rpc(fn: string, args: Record<string, unknown>) {
  return callRpc<unknown>(await createClient(), fn, args);
}

const roleCode = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,39}$/, "Code: 2–40 lowercase letters, digits or underscores, starting with a letter.");

const roleSchema = z.object({
  code: roleCode,
  name: z.string().trim().min(1, "Name is required.").max(60, "Name: at most 60 characters."),
  description: z.string().trim().max(500, "Description: at most 500 characters.").optional(),
  permissions: z.array(z.enum(PERMISSION_KEYS as [string, ...string[]])).max(PERMISSION_KEYS.length),
  isNew: z.boolean(),
});

export type RoleInput = z.input<typeof roleSchema>;

export async function saveRole(input: RoleInput): Promise<ActionResult> {
  await requireViewer("admin");
  const parsed = roleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid role." };
  const r = parsed.data;
  if (r.code === "admin") return { ok: false, message: "The Administrator role cannot be changed." };
  const { error } = await rpc("upsert_app_role", {
    p_code: r.code,
    p_name: r.name,
    p_description: r.description || null,
    p_permissions: r.permissions,
    p_is_new: r.isNew,
  });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: r.isNew ? `Role “${r.name}” created.` : `Role “${r.name}” saved. Its accounts have the new permissions immediately.` };
}

export async function deleteRole(code: string): Promise<ActionResult> {
  await requireViewer("admin");
  const parsed = roleCode.safeParse(code);
  if (!parsed.success) return { ok: false, message: "Invalid role." };
  const { error } = await rpc("delete_app_role", { p_code: parsed.data });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: "Role deleted." };
}

const accessSchema = z
  .object({
    email: z.email().max(254),
    role: roleCode,
    allProjects: z.boolean(),
    programs: z.array(z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,19}$/)).max(50),
    projectCodes: z.array(z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,39}$/)).max(200),
  })
  .refine((a) => a.allProjects || a.programs.length + a.projectCodes.length > 0, {
    message: "Choose at least one program or project, or give access to all projects.",
  })
  .refine((a) => a.role !== "admin" || a.allProjects, { message: "Administrators always have access to all projects." });

export type AccessInput = z.input<typeof accessSchema>;

function accessArgs(a: z.output<typeof accessSchema>) {
  return {
    p_email: a.email.toLowerCase(),
    p_role: a.role,
    p_all_projects: a.allProjects,
    p_programs: a.allProjects ? [] : a.programs,
    p_project_codes: a.allProjects ? [] : a.projectCodes,
  };
}

/** Invites a new user (if needed) and grants a role and project access. */
export async function grantAccess(input: AccessInput): Promise<ActionResult> {
  await requireViewer("admin");
  const parsed = accessSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Enter a valid email, role and project access." };
  const args = accessArgs(parsed.data);

  let { error } = await rpc("set_user_access", args);
  let invited = false;
  if (error && /Invite the user first/i.test(error.message)) {
    if (!hasAdminCredentials()) {
      return { ok: false, message: "That user does not exist yet, and SUPABASE_SECRET_KEY is not configured to send invitations. Create the user in Supabase first." };
    }
    const admin = createAdminClient();
    const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(args.p_email, {
      redirectTo: `${siteUrl()}/auth/callback?next=/account/password`,
    });
    if (inviteError) return { ok: false, message: `Invitation failed: ${inviteError.message}` };
    invited = true;
    ({ error } = await rpc("set_user_access", args));
  }
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: invited ? `Invitation sent to ${args.p_email}.` : `Access granted to ${args.p_email}.` };
}

/** Changes the role and/or project access of an existing account. */
export async function updateAccess(input: AccessInput): Promise<ActionResult> {
  const viewer = await requireViewer("admin");
  const parsed = accessSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid access." };
  if (viewer.email && parsed.data.email.toLowerCase() === viewer.email.toLowerCase() && parsed.data.role !== "admin") {
    return { ok: false, message: "You cannot remove your own administrator role." };
  }
  const { error } = await rpc("set_user_access", accessArgs(parsed.data));
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `Access updated for ${parsed.data.email}.` };
}

const userIdSchema = z.uuid();

export async function revokeAccess(userId: string): Promise<ActionResult> {
  const viewer = await requireViewer("admin");
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) return { ok: false, message: "Invalid user." };
  if (parsed.data === viewer.userId) return { ok: false, message: "You cannot revoke your own access." };
  const { error } = await rpc("revoke_user_role", { p_user_id: parsed.data });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: "Access revoked." };
}
