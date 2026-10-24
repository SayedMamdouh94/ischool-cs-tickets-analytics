/** Shapes returned by the import-job SQL functions (supabase/migrations/*_admin_and_import_jobs.sql). */

export type ImportJobStatus =
  | "awaiting_upload"
  | "uploaded"
  | "validating"
  | "ready"
  | "importing"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled";

export type ImportMode = "upsert" | "archive_and_start";
export type InvalidRowPolicy = "all_or_nothing" | "import_valid_rows";

export interface ImportPreview {
  counts: {
    total: number;
    valid: number;
    invalid: number;
    duplicates: number;
    collisions: number;
    new: number;
    updated: number;
    unchanged: number;
    stale: number;
  };
  field_changes: Record<string, number>;
  conflicts: { stale_rows: number; regressions: number; collisions: number; ids_in_other_cycles_or_archived: number };
  absent_existing: number;
  ids_in_archived_target: number;
  computed_at: string;
}

export interface ImportValidationSummary {
  rows_total?: number;
  rows_valid?: number;
  rows_invalid?: number;
  format?: string;
  sheet?: string;
  delimiter?: string;
  by_code?: Record<string, { severity: "error" | "warning" | "info"; count: number }>;
  organization_filled?: number;
  new_topics?: { topic: string; rows: number }[];
  unconfigured_statuses?: { status: string; rows: number }[];
  file_error?: string;
  file_error_code?: string;
  stats?: { data_as_of?: string | null; min_created_at?: string | null; max_created_at?: string | null };
}

export interface ImportJob {
  id: string;
  mode: ImportMode;
  status: ImportJobStatus;
  project_id: string | null;
  archive_scope: "project" | "cycle" | null;
  new_project: { code: string; name: string; program: string; intake: string; organization_id: number; description?: string | null } | null;
  new_cycle: { code: string; name: string; description?: string | null } | null;
  storage_path: string;
  original_filename: string;
  file_format: "csv" | "xlsx";
  declared_size_bytes: number;
  file_size_bytes: number | null;
  file_hash: string | null;
  uploaded_at: string | null;
  rows_total: number | null;
  rows_staged: number;
  rows_valid: number | null;
  rows_invalid: number | null;
  warnings_count: number | null;
  data_as_of: string | null;
  min_created_at: string | null;
  max_created_at: string | null;
  validation_summary: ImportValidationSummary;
  preview: ImportPreview | null;
  preview_version: number;
  preview_computed_at: string | null;
  invalid_row_policy: InvalidRowPolicy | null;
  import_run_id: string | null;
  rows_applied: number;
  rows_to_apply: number | null;
  progress_phase: string | null;
  progress_done: number;
  progress_total: number;
  attempts: number;
  max_attempts: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  error_code: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface ImportJobDetail {
  job: ImportJob;
  project: { code: string; name: string; status: string; organization_id: number } | null;
  archive_project: { code: string; name: string; status: string } | null;
  archive_cycle: { code: string; name: string; status: string } | null;
  run: {
    id: string;
    status: string;
    inserted_count: number;
    updated_count: number;
    skipped_unchanged_count: number;
    skipped_stale_count: number;
    rejected_count: number;
    records_in_file: number | null;
    completed_at: string | null;
    error_summary: string | null;
  } | null;
  issue_counts: { severity: "error" | "warning" | "info"; code: string; count: number }[];
  events: { at: string; event: string; details: Record<string, unknown>; email: string | null }[];
  created_by_email: string | null;
  confirmed_by_email: string | null;
  stalled: boolean;
  now: string;
}

export interface ImportJobListItem {
  id: string;
  mode: ImportMode;
  status: ImportJobStatus;
  original_filename: string;
  file_format: "csv" | "xlsx";
  file_size_bytes: number | null;
  created_at: string;
  confirmed_at: string | null;
  completed_at: string | null;
  rows_total: number | null;
  rows_valid: number | null;
  rows_invalid: number | null;
  warnings_count: number | null;
  rows_applied: number;
  rows_to_apply: number | null;
  rows_staged: number;
  progress_phase: string | null;
  error_code: string | null;
  last_error: string | null;
  import_run_id: string | null;
  archive_scope: "project" | "cycle" | null;
  project: string | null;
  project_name: string | null;
  archive_project: string | null;
  archive_cycle: string | null;
  created_by_email: string | null;
  stalled: boolean;
}

export interface ImportIssueRow {
  severity: "error" | "warning" | "info";
  code: string;
  row_number: number | null;
  line: number | null;
  ticket_id: number | null;
  column_name: string | null;
  message: string;
  value_excerpt: string | null;
}

export const ACTIVE_JOB_STATUSES: ImportJobStatus[] = ["awaiting_upload", "uploaded", "validating", "ready", "importing"];

export const JOB_STATUS_LABELS: Record<ImportJobStatus, string> = {
  awaiting_upload: "Waiting for upload",
  uploaded: "Uploaded",
  validating: "Validating",
  ready: "Ready for confirmation",
  importing: "Importing",
  completed: "Completed",
  completed_with_errors: "Completed with rejected rows",
  failed: "Failed",
  cancelled: "Cancelled",
};
