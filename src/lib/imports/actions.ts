"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireViewer } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { createAdminClient, hasAdminCredentials } from "@/lib/supabase/admin";
import { IMPORT_BUCKET, MAX_IMPORT_BYTES } from "./constants";
import { scheduleWorker } from "./worker";

/**
 * Import workflow mutations. Each action verifies the administrator role here
 * and the SQL function verifies it again in PostgreSQL (and audits it). The
 * file itself never passes through these actions: the browser uploads it
 * directly to the private bucket with a signed URL scoped to one path.
 */

export interface ImportActionResult<T = undefined> {
  ok: boolean;
  message: string;
  data?: T;
}

async function rpc<T>(fn: string, args: Record<string, unknown>) {
  return callRpc<T>(await createClient(), fn, args);
}

const projectSpec = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(1).max(120),
  program: z.string().trim().min(2).max(20),
  intake: z.string().trim().min(1).max(60),
  intake_group: z.string().trim().max(40).optional(),
  organization_id: z.coerce.number().int().positive().max(999_999_999),
  description: z.string().trim().max(1000).optional(),
});

const cycleSpec = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
});

const startSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("upsert"),
    project_code: z.string().min(2).max(40),
    filename: z.string().min(1).max(255),
    size_bytes: z.number().int().positive().max(MAX_IMPORT_BYTES),
  }),
  z.object({
    mode: z.literal("archive_and_start"),
    archive_scope: z.enum(["project", "cycle"]),
    archive_project_code: z.string().max(40).optional(),
    archive_cycle_code: z.string().max(40).optional(),
    new_project: projectSpec,
    new_cycle: cycleSpec.optional(),
    filename: z.string().min(1).max(255),
    size_bytes: z.number().int().positive().max(MAX_IMPORT_BYTES),
  }),
]);

export type StartImportInput = z.input<typeof startSchema>;

/** Creates the job and returns a signed upload URL for exactly its storage path. */
export async function startImport(
  input: StartImportInput,
): Promise<ImportActionResult<{ jobId: string; signedUrl: string; contentType: string }>> {
  await requireViewer("admin");
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, message: first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid import settings." };
  }
  if (!hasAdminCredentials()) {
    return { ok: false, message: "Uploads need SUPABASE_SECRET_KEY on the server to issue signed upload URLs. Configure it in the hosting environment." };
  }
  const { data, error } = await rpc<{ id: string; storage_path: string; format: "csv" | "xlsx" }>("create_import_job", { p_spec: parsed.data });
  if (error) return { ok: false, message: error.message };

  const { data: signed, error: signError } = await createAdminClient().storage.from(IMPORT_BUCKET).createSignedUploadUrl(data.storage_path);
  if (signError || !signed) {
    await rpc("cancel_import_job", { p_job_id: data.id });
    return { ok: false, message: `Could not prepare the upload: ${signError?.message ?? "unknown error"}` };
  }
  return {
    ok: true,
    message: "Upload prepared.",
    data: {
      jobId: data.id,
      signedUrl: signed.signedUrl,
      contentType: data.format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv",
    },
  };
}

const jobId = z.uuid();

/** Called by the browser after the upload finished: queues validation. */
export async function completeUpload(id: string): Promise<ImportActionResult> {
  await requireViewer("admin");
  if (!jobId.safeParse(id).success) return { ok: false, message: "Invalid import." };
  const { error } = await rpc("mark_import_uploaded", { p_job_id: id });
  if (error) return { ok: false, message: error.message };
  scheduleWorker(id);
  return { ok: true, message: "File uploaded. Validation started." };
}

const confirmSchema = z.object({
  id: z.uuid(),
  policy: z.enum(["all_or_nothing", "import_valid_rows"]),
  previewVersion: z.number().int().min(0),
});

export async function confirmImport(input: z.input<typeof confirmSchema>): Promise<ImportActionResult<{ previewChanged?: boolean }>> {
  await requireViewer("admin");
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid confirmation." };
  const { data, error } = await rpc<{ preview_changed?: boolean; message?: string }>("confirm_import_job", {
    p_job_id: parsed.data.id,
    p_policy: parsed.data.policy,
    p_preview_version: parsed.data.previewVersion,
  });
  if (error) return { ok: false, message: error.message };
  if (data?.preview_changed) {
    refresh();
    return { ok: false, message: data.message ?? "The preview changed; review it and confirm again.", data: { previewChanged: true } };
  }
  scheduleWorker(parsed.data.id);
  refresh();
  return { ok: true, message: "Import confirmed. Rows are being imported in the background." };
}

export async function cancelImport(id: string): Promise<ImportActionResult> {
  await requireViewer("admin");
  if (!jobId.safeParse(id).success) return { ok: false, message: "Invalid import." };
  const { error } = await rpc("cancel_import_job", { p_job_id: id });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: "Import cancelled." };
}

export async function retryImport(id: string): Promise<ImportActionResult> {
  await requireViewer("admin");
  if (!jobId.safeParse(id).success) return { ok: false, message: "Invalid import." };
  const { error } = await rpc("retry_import_job", { p_job_id: id });
  if (error) return { ok: false, message: error.message };
  scheduleWorker(id);
  refresh();
  return { ok: true, message: "Retry started." };
}

export async function refreshPreview(id: string): Promise<ImportActionResult> {
  await requireViewer("admin");
  if (!jobId.safeParse(id).success) return { ok: false, message: "Invalid import." };
  const { error } = await rpc("refresh_import_preview", { p_job_id: id });
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true, message: "Preview recomputed against the current data." };
}
