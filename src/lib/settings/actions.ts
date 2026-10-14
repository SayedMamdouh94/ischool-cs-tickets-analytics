"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireViewer } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { createAdminClient, hasAdminCredentials } from "@/lib/supabase/admin";
import { siteUrl } from "@/lib/env";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Settings mutations. Each action re-verifies the administrator role here AND
 * the SQL functions enforce it again in PostgreSQL (and audit the change).
 */
async function rpc(fn: string, args: Record<string, unknown>) {
  return callRpc<unknown>(await createClient(), fn, args);
}

const thresholdSchema = z.object({
  response_hours: z.coerce.number().positive().max(8760),
  resolution_hours: z.coerce.number().positive().max(8760),
});

export async function saveThresholds(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireViewer("admin");
  const parsed = thresholdSchema.safeParse({ response_hours: formData.get("response_hours"), resolution_hours: formData.get("resolution_hours") });
  if (!parsed.success) return { ok: false, message: "Thresholds must be positive numbers of hours (max 8,760)." };
  for (const [key, value] of Object.entries(parsed.data)) {
    const { error } = await rpc("update_threshold", { p_key: key, p_value_hours: value });
    if (error) return { ok: false, message: error.message };
  }
  refresh();
  return { ok: true, message: "Thresholds saved. All dashboards now use the new values." };
}

const prefsSchema = z.object({
  date_preset_anchor: z.enum(["dataset_end", "today"]),
  default_date_preset: z.enum(["all", "last_7", "last_30", "last_90", "this_month"]),
  organization_name: z.string().trim().min(1).max(80),
});

export async function savePreferences(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireViewer("admin");
  const parsed = prefsSchema.safeParse({
    date_preset_anchor: formData.get("date_preset_anchor"),
    default_date_preset: formData.get("default_date_preset"),
    organization_name: formData.get("organization_name"),
  });
  if (!parsed.success) return { ok: false, message: "Invalid preference values." };
  for (const [key, value] of Object.entries(parsed.data)) {
    const { error } = await rpc("update_app_setting", { p_key: key, p_value: value });
    if (error) return { ok: false, message: error.message };
  }
  refresh();
  return { ok: true, message: "Preferences saved." };
}

const projectSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
  name: z.string().trim().min(1).max(120),
  display_order: z.coerce.number().int().min(0).max(999),
  is_active: z.enum(["on", "off"]).optional(),
  file_name_hint: z.string().trim().min(1).max(120),
});

export async function saveProject(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireViewer("admin");
  const parsed = projectSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    display_order: formData.get("display_order"),
    is_active: formData.get("is_active") ?? "off",
    file_name_hint: formData.get("file_name_hint"),
  });
  if (!parsed.success) return { ok: false, message: "Invalid project values." };
  const { error } = await rpc("update_project", {
    p_code: parsed.data.code,
    p_name: parsed.data.name,
    p_display_order: parsed.data.display_order,
    p_is_active: parsed.data.is_active === "on",
    p_file_name_hint: parsed.data.file_name_hint,
  });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `Saved ${parsed.data.code}.` };
}

const grantSchema = z.object({
  email: z.email().max(254),
  role: z.enum(["admin", "analyst"]),
});

/** Invites a new user (if needed) and grants a role. */
export async function grantAccess(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireViewer("admin");
  const parsed = grantSchema.safeParse({ email: formData.get("email"), role: formData.get("role") });
  if (!parsed.success) return { ok: false, message: "Enter a valid email and role." };
  const email = parsed.data.email.toLowerCase();

  let { error } = await rpc("set_user_role", { p_email: email, p_role: parsed.data.role });
  let invited = false;
  if (error && /Invite the user first/i.test(error.message)) {
    if (!hasAdminCredentials()) {
      return { ok: false, message: "That user does not exist yet, and SUPABASE_SECRET_KEY is not configured to send invitations. Create the user in Supabase first." };
    }
    const admin = createAdminClient();
    const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${siteUrl()}/auth/callback?next=/account/password`,
    });
    if (inviteError) return { ok: false, message: `Invitation failed: ${inviteError.message}` };
    invited = true;
    ({ error } = await rpc("set_user_role", { p_email: email, p_role: parsed.data.role }));
  }
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: invited ? `Invitation sent to ${email} with the ${parsed.data.role} role.` : `${email} now has the ${parsed.data.role} role.` };
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

export async function changeRole(email: string, role: "admin" | "analyst"): Promise<ActionResult> {
  await requireViewer("admin");
  const parsed = grantSchema.safeParse({ email, role });
  if (!parsed.success) return { ok: false, message: "Invalid input." };
  const { error } = await rpc("set_user_role", { p_email: parsed.data.email, p_role: parsed.data.role });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `Role updated to ${role}.` };
}
