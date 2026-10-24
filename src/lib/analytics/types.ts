/** Shapes returned by the analytics SQL functions (supabase/migrations/*_analytics.sql). */

export type LifecycleStatus = "draft" | "active" | "archived";

export interface ProjectOption {
  code: string;
  name: string;
  program: string;
  intake: string;
  intake_group: string;
  organization_id: number;
  status: LifecycleStatus;
  is_active: boolean;
}

/** The analytical scope a page is computed for: one reporting cycle, archived projects only on request. */
export interface ResolvedScope {
  cycle: string;
  cycle_name: string;
  cycle_status: LifecycleStatus;
  is_current: boolean;
  include_archived: boolean;
  requested_cycle: string | null;
}

export interface ProjectCoverage {
  project: string;
  name: string;
  status: LifecycleStatus;
  tickets: number;
  first_date: string | null;
  last_date: string | null;
  snapshot_at: string | null;
  last_complete_date: string | null;
}

export interface ScopeCycle {
  code: string;
  name: string;
  status: LifecycleStatus;
  is_current: boolean;
  archived_at: string | null;
  projects: { code: string; name: string; status: LifecycleStatus; tickets: number; snapshot_at: string | null }[];
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
  /** null when no reporting cycle is current (or the requested one does not exist). */
  scope: ResolvedScope | null;
  projects: ProjectOption[];
  programs: string[];
  intakes: string[];
  statuses: (ValueCount & { class: "open" | "closed" | "unclassified"; label: string | null })[];
  topics: ValueCount[];
  responders: ValueCount[];
  resolvers: ValueCount[];
  categories: CategoryOption[];
  date_range: { min: string | null; max: string | null; min_at: string | null; max_at: string | null };
  latest_import: { completed_at: string | null; data_as_of: string | null; earliest_data_as_of: string | null };
  coverage: ProjectCoverage[];
  active_imports: { project: string; status: string; rows_applied: number; rows_to_apply: number | null; started_at: string | null }[];
  partial_imports: { project: string; rows_applied: number; rows_to_apply: number | null }[];
  latest_rejections: { project: string; rejected: number; source_filename: string }[];
  unmapped_topics: number;
  unclassified_status_tickets: number;
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
  closed_status: number;
  unclassified_status: number;
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
  status_classes: { status: string; class: "open" | "closed" | "unclassified"; count: number }[];
  reconstructed: { date: string; open: number; created: number; resolved: number }[];
}

export type PeriodExclusion = "ok" | "no_data" | "insufficient_history" | "export_ends_before_period";

export interface PeriodComparison {
  dimension: string;
  /** aligned: each project uses its own latest window; calendar: one explicit window for all. */
  mode: "aligned" | "calendar";
  days: number;
  /** Overall span of the compared windows. */
  current: { from: string; to: string; days: number } | null;
  previous: { from: string; to: string; days: number } | null;
  totals: { current: number; previous: number };
  projects: {
    project: string;
    name: string;
    included: boolean;
    reason: PeriodExclusion;
    first_date: string | null;
    last_complete_date: string | null;
    current_from: string | null;
    current_to: string | null;
    previous_from: string | null;
    previous_to: string | null;
    current: number;
    previous: number;
  }[];
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
  project_status?: LifecycleStatus;
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

export interface TicketCandidate {
  project_code: string;
  project_name: string;
  project_status: LifecycleStatus;
  cycle: string;
  cycle_name: string;
}

export interface AmbiguousTicket {
  ambiguous: true;
  ticket_id: number;
  candidates: TicketCandidate[];
}

export interface TicketDetail extends Omit<TicketRow, "category" | "subcategory"> {
  ambiguous?: undefined;
  cycle: string;
  cycle_name: string;
  status_class: "open" | "closed" | "unclassified";
  source_data_as_of: string;
  changes: { changed_at: string; fields: string[]; values: Record<string, { old: unknown; new: unknown }> | null; source_filename: string | null }[];
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
  /** Source IDs that occur in more than one project of the scope. */
  duplicate_ticket_ids_in_db: number;
  coverage: {
    project: string;
    name: string;
    status: LifecycleStatus;
    tickets: number;
    first_date: string | null;
    last_date: string | null;
    active_days: number;
    snapshot_at: string | null;
    last_complete_date: string | null;
  }[];
  unmapped_topics: { topic: string; tickets: number }[];
  unclassified_statuses: { status: string | null; tickets: number }[];
  import_jobs: {
    id: string;
    project: string;
    status: string;
    original_filename: string;
    rows_applied: number;
    rows_to_apply: number | null;
    rows_invalid: number | null;
    error_code: string | null;
    updated_at: string;
  }[];
  reconciliation: {
    import_run_id: string;
    source_filename: string;
    project: string | null;
    file_hash: string;
    completed_at: string;
    status: string;
    source: "cli" | "web";
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
  project_status: LifecycleStatus | null;
  source: "cli" | "web";
  invalid_row_policy: string | null;
  job_id: string | null;
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

export interface InsightRule {
  key: string;
  value: number;
  min_value: number;
  max_value: number;
  unit: "count" | "ratio" | "factor" | "days" | "score";
  label: string;
  description: string;
  updated_at: string;
}

export interface ReportingCycle {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: LifecycleStatus;
  is_current: boolean;
  archived_at: string | null;
  archive_reason: string | null;
  created_at: string;
  projects: number;
}

export interface SettingsProject extends ProjectOption {
  id: string;
  description: string | null;
  file_name_hint: string;
  display_order: number;
  cycle: string;
  cycle_name: string;
  cycle_status: LifecycleStatus;
  archived_at: string | null;
  archive_reason: string | null;
  archived_via: "project" | "cycle" | null;
  created_at: string;
  tickets: number;
  last_import: { completed_at: string; data_as_of: string | null; source_filename: string; status: string; source: "cli" | "web" } | null;
  snapshot_at: string | null;
  imports: number;
  active_job: { id: string; status: string } | null;
}

export interface Settings {
  thresholds: { key: "response_hours" | "resolution_hours"; value_hours: number; label: string; description: string; updated_at: string }[];
  app: { organization_name?: string; date_preset_anchor?: "dataset_end" | "today"; default_date_preset?: string };
  insight_rules: InsightRule[];
  cycles: ReportingCycle[];
  projects: SettingsProject[];
}

export interface StatusValue {
  status: string;
  tickets: number;
  class: "open" | "closed" | null;
  label: string | null;
  configured: boolean;
  updated_at: string | null;
}

export interface TopicMappings {
  topics: {
    topic: string;
    tickets: number;
    current_cycle_tickets: number;
    projects: string[];
    first_seen: string | null;
    category: string | null;
    category_name: string | null;
    mapped: boolean;
    source: "seed" | "admin" | null;
    updated_at: string | null;
  }[];
  categories: {
    code: string;
    name: string;
    name_ar: string | null;
    description: string | null;
    kind: "category" | "subcategory";
    is_active: boolean;
    sort_order: number;
    topics: number;
  }[];
}

export interface ProjectHistoryEntry {
  id: string;
  source_filename: string;
  source: "cli" | "web";
  status: string;
  started_at: string;
  completed_at: string | null;
  data_as_of: string | null;
  records_in_file: number | null;
  inserted_count: number;
  updated_count: number;
  skipped_unchanged_count: number;
  skipped_stale_count: number;
  rejected_count: number;
  job_id: string | null;
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
