/** Shapes returned by the analytics SQL functions (supabase/migrations/*_analytics.sql). */

export interface ProjectOption {
  code: string;
  name: string;
  program: string;
  intake: string;
  intake_group: string;
  organization_id: number;
  is_active: boolean;
}

export interface ValueCount {
  value: string;
  count: number;
}

export interface CategoryOption {
  code: string;
  name: string;
  name_ar: string | null;
  kind: "category" | "subcategory";
}

export interface FilterOptions {
  projects: ProjectOption[];
  programs: string[];
  intakes: string[];
  statuses: ValueCount[];
  topics: ValueCount[];
  responders: ValueCount[];
  resolvers: ValueCount[];
  categories: CategoryOption[];
  date_range: { min: string | null; max: string | null; min_at: string | null; max_at: string | null };
  latest_import: { completed_at: string | null; data_as_of: string | null };
  total_tickets: number;
}

export type Dimension =
  | "none"
  | "project"
  | "program"
  | "intake"
  | "intake_group"
  | "topic"
  | "category"
  | "subcategory"
  | "responder"
  | "resolver"
  | "status"
  | "response_kind"
  | "lesson"
  | "month";

export interface GroupMetrics {
  key: string;
  label: string;
  tickets: number;
  completed: number;
  pending: number;
  rejected: number;
  missing_status: number;
  other_status: number;
  open_tickets: number;
  with_response_ts: number;
  with_resolution_ts: number;
  with_note: number;
  generic_ack: number;
  unique_owners: number;
  response_n: number;
  response_invalid: number;
  response_avg_s: number | null;
  response_median_s: number | null;
  response_p90_s: number | null;
  response_breaches: number;
  resolution_n: number;
  resolution_invalid: number;
  resolution_avg_s: number | null;
  resolution_median_s: number | null;
  resolution_p90_s: number | null;
  resolution_breaches: number;
  open_breaches: number;
  first_created_at: string | null;
  last_created_at: string | null;
}

export interface GroupedMetrics {
  dimension: Dimension;
  thresholds: { response_seconds: number; resolution_seconds: number };
  rows: GroupMetrics[];
}

export interface CrossTab {
  row_dimension: Dimension;
  col_dimension: Dimension;
  cells: { row: string; col: string; count: number; resolution_median_s: number | null }[];
}

export type Grain = "day" | "week" | "month";
export type SeriesSplit = "none" | "project" | "program" | "intake_group" | "status" | "topic" | "category" | "subcategory";

export interface VolumeSeries {
  grain: Grain;
  split: SeriesSplit;
  points: { bucket: string; key: string; count: number }[];
}

export interface WeekdayHour {
  timezone: string;
  cells: { isodow: number; hour: number; count: number }[];
}

export interface DurationHistogram {
  metric: "response" | "resolution";
  split: "none" | "project" | "program" | "intake_group";
  bucket_edges_hours: number[];
  bins: { bucket: number; key: string; count: number }[];
  excluded: { missing: number; negative: number };
}

export type AgeBucket = "lt_24h" | "1_3d" | "3_7d" | "gt_7d";

export interface Backlog {
  resolution_threshold_seconds: number;
  open: { project: string; status: string; age_bucket: AgeBucket; count: number }[];
  oldest: {
    ticket_id: number;
    project_code: string;
    project_name: string;
    topic: string;
    status: string;
    created_at: string;
    responded_at: string | null;
    responder_name: string | null;
    snapshot_at: string;
    age_seconds: number;
    breaches_resolution_threshold: boolean;
  }[];
  open_by_topic: { topic: string; count: number }[];
  snapshots: { project: string; snapshot_at: string | null }[];
  reconstructed: { date: string; open: number; created: number; resolved: number }[];
}

export interface PeriodComparison {
  dimension: string;
  current: { from: string; to: string; days: number } | null;
  previous: { from: string; to: string; days: number } | null;
  rows: { key: string; label: string | null; current: number; previous: number }[];
}

export interface RecurringSessions {
  summary: {
    sessions_with_tickets: number;
    recurring_sessions: number;
    tickets_in_recurring_sessions: number;
    min_students: number;
  };
  sessions: {
    session_ref: string;
    project_code: string;
    lesson_name: string | null;
    tickets: number;
    students: number;
    open_tickets: number;
    topics: string[];
    first_created_at: string;
    last_created_at: string;
  }[];
}

export interface TicketRow {
  ticket_id: number;
  project_code: string;
  project_name: string;
  topic: string;
  status: string | null;
  owner_id: string | null;
  created_at: string;
  responded_at: string | null;
  resolved_at: string | null;
  responder_name: string | null;
  resolved_by: string | null;
  response_seconds: number | null;
  resolution_seconds: number | null;
  response_kind: string;
  lesson_name: string | null;
  category: string | null;
  subcategory: string | null;
}

export interface TicketSearchResult {
  total: number;
  page: number;
  page_size: number;
  sort: string;
  dir: "asc" | "desc";
  content_search: boolean;
  rows: TicketRow[];
}

export interface TicketDetail extends Omit<TicketRow, "category" | "subcategory"> {
  organization_id: number;
  priority: string | null;
  department: string | null;
  owner_type: string | null;
  affected_student_id: string | null;
  sub_topic: string | null;
  session_ref: string | null;
  message_language: string | null;
  source_filename: string;
  source_row_number: number;
  imported_at: string;
  updated_at: string;
  category: string | null;
  subcategory: string | null;
  classification: { method: string; version: string; confidence: number | null; evidence: { matched_terms?: string[] } } | null;
  content_visible: boolean;
  message: string | null;
  response: string | null;
  note: string | null;
  attachments: { type: "request" | "response"; position: number; url: string; host: string | null; file_name: string | null; extension: string | null }[] | null;
  attachment_count: number;
}

export interface DataQuality {
  total: number;
  missing_by_field: { field: string; missing: number }[];
  consistency: Record<string, number | boolean>;
  bulk_resolution_events: { resolved_at: string; resolved_by: string | null; tickets: number }[];
  repeat_submissions: {
    same_session_groups: number;
    same_session_tickets: number;
    same_day_topic_groups: number;
    same_day_topic_tickets: number;
  };
  response_kinds: Record<string, number>;
  import_errors: { error_code: string; count: number }[];
  duplicate_ticket_ids_in_db: number;
  coverage: {
    project: string;
    name: string;
    tickets: number;
    first_date: string | null;
    last_date: string | null;
    active_days: number;
    snapshot_at: string | null;
  }[];
  reconciliation: {
    import_run_id: string;
    source_filename: string;
    project: string | null;
    file_hash: string;
    completed_at: string;
    status: string;
    records_in_file: number;
    inserted_count: number;
    updated_count: number;
    skipped_count: number;
    rejected_count: number;
    reconciliation: {
      status_counts?: Record<string, number>;
      missing?: Record<string, number>;
      anomalies?: Record<string, number>;
      offsets?: Record<string, number>;
      offset_mismatches_vs_cairo?: number;
    };
    db_project_tickets: number;
    db_tickets_from_file: number;
  }[];
}

export interface ImportRun {
  id: string;
  source_filename: string;
  project: string | null;
  project_name: string | null;
  file_hash: string;
  file_size_bytes: number | null;
  started_at: string;
  completed_at: string | null;
  status: string;
  records_in_file: number | null;
  inserted_count: number;
  updated_count: number;
  skipped_unchanged_count: number;
  skipped_stale_count: number;
  skipped_count: number;
  rejected_count: number;
  data_as_of: string | null;
  min_created_at: string | null;
  max_created_at: string | null;
  duplicate_of_run_id: string | null;
  update_policy: string;
  importer_version: string;
  error_summary: string | null;
}

export interface ImportRunDetail {
  run: ImportRun & { reconciliation: Record<string, unknown> };
  errors: {
    id: number;
    source_row_number: number | null;
    ticket_id: number | null;
    error_code: string;
    validation_error: string;
    raw_row: Record<string, string> | null;
    recorded_at: string;
  }[];
  raw_rows_visible: boolean;
}

export interface Settings {
  thresholds: { key: "response_hours" | "resolution_hours"; value_hours: number; label: string; description: string; updated_at: string }[];
  app: { organization_name?: string; date_preset_anchor?: "dataset_end" | "today"; default_date_preset?: string };
  projects: (ProjectOption & { id: string; file_name_hint: string; display_order: number; tickets: number })[];
}

export interface AppUser {
  user_id: string;
  email: string;
  role: "admin" | "analyst" | null;
  created_at: string;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  invited_at: string | null;
}

export interface AuditEvent {
  id: number;
  occurred_at: string;
  action: string;
  details: Record<string, unknown>;
  email: string | null;
}
