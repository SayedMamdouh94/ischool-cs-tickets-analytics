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
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,39}$/, "Code: 2–40 capital letters, digits or underscores, starting with a letter."),
  name: z.string().trim().min(1, "Name is required.").max(120),
  program: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,19}$/, "Program: 2–20 capital letters or digits (e.g. DECI)."),
  intake: z.string().trim().min(1, "Intake is required.").max(60),
  intake_group: z.string().trim().max(40).optional(),
  organization_id: z.coerce.number({ error: "Organization ID must be a number." }).int().positive().max(999_999_999),
  description: z.string().trim().max(1000).optional(),
  display_order: z.coerce.number().int().min(0).max(999).optional(),
});

function projectFromForm(formData: FormData) {
  const opt = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };
  return projectSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    program: formData.get("program"),
    intake: formData.get("intake"),
    intake_group: opt("intake_group"),
    organization_id: formData.get("organization_id"),
    description: opt("description"),
    display_order: opt("display_order"),
  });
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid values.";
}

export async function createProject(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireViewer("admin");
  const parsed = projectFromForm(formData);
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  const cycle = formData.get("cycle");
  const { error } = await rpc("create_project", { p_project: parsed.data, p_cycle: typeof cycle === "string" && cycle ? cycle : null });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `Project ${parsed.data.code} created. It is empty until you import data into it.` };
}

export async function saveProject(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireViewer("admin");
  const parsed = projectFromForm(formData);
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  const { error } = await rpc("update_project", { p_code: parsed.data.code, p_project: parsed.data });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `Saved ${parsed.data.code}.` };
}

const codeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/);

export async function archiveProject(code: string, reason: string, confirm: string): Promise<ActionResult> {
  await requireViewer("admin");
  if (!codeSchema.safeParse(code).success) return { ok: false, message: "Invalid project." };
  const { error } = await rpc("archive_project", { p_code: code, p_reason: reason.slice(0, 500), p_confirm: confirm });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `${code} archived. Its tickets are kept and available in the historical view.` };
}

export async function restoreProject(code: string): Promise<ActionResult> {
  await requireViewer("admin");
  if (!codeSchema.safeParse(code).success) return { ok: false, message: "Invalid project." };
  const { error } = await rpc("restore_project", { p_code: code });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `${code} restored to the active dashboard.` };
}

const cycleSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,39}$/, "Code: 2–40 capital letters, digits or underscores (e.g. CYCLE_2027)."),
  name: z.string().trim().min(1, "Name is required.").max(120),
  description: z.string().trim().max(1000).optional(),
});

export async function createCycle(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireViewer("admin");
  const parsed = cycleSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    description: (formData.get("description") as string | null) || undefined,
  });
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  const { error } = await rpc("create_reporting_cycle", { p_cycle: parsed.data, p_make_current: formData.get("make_current") === "on" });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `Reporting cycle ${parsed.data.code} created.` };
}

export async function setCurrentCycle(code: string): Promise<ActionResult> {
  await requireViewer("admin");
  if (!codeSchema.safeParse(code).success) return { ok: false, message: "Invalid cycle." };
  const { error } = await rpc("set_current_cycle", { p_code: code });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `${code} is now the dashboard's current cycle.` };
}

export async function archiveCycle(code: string, reason: string, confirm: string, newCurrent: string | null): Promise<ActionResult> {
  await requireViewer("admin");
  if (!codeSchema.safeParse(code).success) return { ok: false, message: "Invalid cycle." };
  const { data, error } = await callRpc<{ archived_projects: number }>(await createClient(), "archive_cycle", {
    p_code: code,
    p_reason: reason.slice(0, 500),
    p_confirm: confirm,
    p_new_current: newCurrent,
  });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `${code} archived with ${data.archived_projects} project(s). Nothing was deleted.` };
}

export async function restoreCycle(code: string, makeCurrent: boolean): Promise<ActionResult> {
  await requireViewer("admin");
  if (!codeSchema.safeParse(code).success) return { ok: false, message: "Invalid cycle." };
  const { data, error } = await callRpc<{ restored_projects: number }>(await createClient(), "restore_cycle", { p_code: code, p_make_current: makeCurrent });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `${code} restored (${data.restored_projects} project(s)).` };
}

export async function mapTopic(topic: string, categoryCode: string | null): Promise<ActionResult> {
  await requireViewer("admin");
  if (typeof topic !== "string" || topic.trim().length === 0 || topic.length > 500) return { ok: false, message: "Invalid topic." };
  const { data, error } = await callRpc<{ tickets_reclassified: number }>(await createClient(), "set_topic_category", {
    p_topic: topic,
    p_category_code: categoryCode,
  });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `Mapping saved; ${data.tickets_reclassified.toLocaleString("en-US")} ticket(s) reclassified.` };
}

const categorySchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,59}$/, "Code: lowercase letters, digits or underscores (e.g. certificates)."),
  name_en: z.string().trim().min(1, "English name is required.").max(120),
  name_ar: z.string().trim().max(120).optional(),
  description: z.string().trim().max(500).optional(),
});

export async function saveCategory(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireViewer("admin");
  const parsed = categorySchema.safeParse({
    code: formData.get("code"),
    name_en: formData.get("name_en"),
    name_ar: (formData.get("name_ar") as string | null) || undefined,
    description: (formData.get("description") as string | null) || undefined,
  });
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  const { error } = await rpc("upsert_category", {
    p_code: parsed.data.code,
    p_name_en: parsed.data.name_en,
    p_name_ar: parsed.data.name_ar ?? null,
    p_description: parsed.data.description ?? null,
    p_is_active: true,
  });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `Category ${parsed.data.code} saved.` };
}

export async function setStatusClass(status: string, statusClass: "open" | "closed"): Promise<ActionResult> {
  await requireViewer("admin");
  if (!["open", "closed"].includes(statusClass)) return { ok: false, message: "Invalid class." };
  const { error } = await rpc("set_status_class", { p_status: status, p_class: statusClass, p_label: null });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: `"${status === "__none__" ? "Missing status" : status}" now counts as ${statusClass}.` };
}

export async function saveInsightRules(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireViewer("admin");
  const changed: string[] = [];
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("rule:") || typeof raw !== "string") continue;
    const original = formData.get(`orig:${key.slice(5)}`);
    if (original === raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) return { ok: false, message: `Invalid number for ${key.slice(5)}.` };
    const { error } = await rpc("update_insight_rule", { p_key: key.slice(5), p_value: value });
    if (error) return { ok: false, message: error.message };
    changed.push(key.slice(5));
  }
  refresh();
  return { ok: true, message: changed.length ? `Saved ${changed.length} insight setting(s). Insights now use the new values.` : "No changes." };
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
