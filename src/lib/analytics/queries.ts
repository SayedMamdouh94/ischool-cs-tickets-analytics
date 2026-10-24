import "server-only";
import { cache } from "react";
import { requireViewer } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import {
  parseFilters,
  resolveDateRange,
  toRpcFilters,
  toRpcScope,
  type RpcScope,
  type DashboardFilters,
  type DateRange,
  type RpcFilters,
  type SearchParamsRecord,
} from "@/lib/filters/schema";
import type { ImportIssueRow, ImportJobDetail, ImportJobListItem } from "@/lib/imports/types";
import type {
  AmbiguousTicket,
  AppUser,
  AuditEvent,
  Backlog,
  CrossTab,
  DataQuality,
  Dimension,
  DurationHistogram,
  FilterOptions,
  Grain,
  GroupedMetrics,
  ImportRun,
  ImportRunDetail,
  PeriodComparison,
  ProjectHistoryEntry,
  RecurringSessions,
  ScopeCycle,
  StatusValue,
  TopicMappings,
  SeriesSplit,
  Settings,
  TicketDetail,
  TicketSearchResult,
  VolumeSeries,
  WeekdayHour,
} from "./types";

/**
 * Server-side analytics data access. Every call:
 *   1. verifies the session and application role (requireViewer), then
 *   2. calls a SQL function as that user (RLS + in-function role checks apply).
 * Aggregation happens in PostgreSQL; only aggregates (or one page of rows)
 * travel to the server and browser. Results are memoized per request.
 */

export class AnalyticsError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  await requireViewer("analyst");
  const { data, error } = await callRpc<T>(await createClient(), fn, args);
  if (error) {
    throw new AnalyticsError(error.code === "42501" ? "You do not have access to this data." : error.message, error.code);
  }
  return data as T;
}

// Requests are memoized on a stable JSON key (React cache compares args by identity).
const key = (v: unknown) => JSON.stringify(v ?? {});

const cachedRpc = cache(<T>(fn: string, argsKey: string) => rpc<T>(fn, JSON.parse(argsKey)));
function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  return cachedRpc(fn, key(args)) as Promise<T>;
}

export const getFilterOptions = (scope: RpcScope = {}) => call<FilterOptions>("get_filter_options", { p_scope: scope });
export const getSettings = () => call<Settings>("get_settings");
export const getScopeCatalog = () => call<ScopeCycle[]>("get_scope_catalog");
export const getTopicMappings = () => call<TopicMappings>("get_topic_mappings");
export const getStatusValues = () => call<StatusValue[]>("get_status_values");
export const getProjectHistory = (code: string) => call<ProjectHistoryEntry[] | null>("get_project_history", { p_code: code });

export interface FilterContext {
  filters: DashboardFilters;
  range: DateRange;
  rpc: RpcFilters;
  options: FilterOptions;
  anchor: "dataset_end" | "today";
}

/** Parses URL filters and resolves the date preset against the dataset. */
export async function resolveFilterContext(searchParams: SearchParamsRecord): Promise<FilterContext> {
  const filters = parseFilters(searchParams);
  const [options, settings] = await Promise.all([getFilterOptions(toRpcScope(filters)), getSettings()]);
  const anchor = settings.app.date_preset_anchor === "today" ? "today" : "dataset_end";
  const range = resolveDateRange(filters, { datasetMax: options.date_range.max, anchor });
  return { filters, range, rpc: toRpcFilters(filters, range), options, anchor };
}

export const getGroupedMetrics = (f: RpcFilters, dimension: Dimension, limit = 200) =>
  call<GroupedMetrics>("get_grouped_metrics", { p_filters: f, p_dimension: dimension, p_limit: limit });

export const getCrossTab = (f: RpcFilters, row: Dimension, col: Dimension) =>
  call<CrossTab>("get_cross_tab", { p_filters: f, p_row_dimension: row, p_col_dimension: col });

export const getVolumeSeries = (f: RpcFilters, grain: Grain, split: SeriesSplit = "none") =>
  call<VolumeSeries>("get_volume_series", { p_filters: f, p_grain: grain, p_split: split });

export const getWeekdayHour = (f: RpcFilters) => call<WeekdayHour>("get_weekday_hour", { p_filters: f });

export const getDurationHistogram = (
  f: RpcFilters,
  metric: "response" | "resolution",
  split: DurationHistogram["split"] = "none",
) => call<DurationHistogram>("get_duration_histogram", { p_filters: f, p_metric: metric, p_split: split });

export const getBacklog = (f: RpcFilters, oldestLimit = 25) =>
  call<Backlog>("get_backlog", { p_filters: f, p_oldest_limit: oldestLimit });

export const getPeriodComparison = (f: RpcFilters, dimension: string, days: number | null = null) =>
  call<PeriodComparison>("get_period_comparison", { p_filters: f, p_dimension: dimension, p_days: days });

export const getRecurringSessions = (f: RpcFilters, minStudents = 2, limit = 25) =>
  call<RecurringSessions>("get_recurring_sessions", { p_filters: f, p_min_students: minStudents, p_limit: limit });

export const searchTickets = (
  f: RpcFilters,
  opts: { search?: string; sort?: string; dir?: "asc" | "desc"; page?: number; pageSize?: number },
) =>
  call<TicketSearchResult>("search_tickets", {
    p_filters: f,
    p_search: opts.search ?? null,
    p_sort: opts.sort ?? "created_at",
    p_dir: opts.dir ?? "desc",
    p_page: opts.page ?? 1,
    p_page_size: opts.pageSize ?? 25,
  });

/** Not memoized: each detail view of raw content is audited in the database. */
export const getTicketDetail = (ticketId: number, projectCode?: string | null) =>
  rpc<TicketDetail | AmbiguousTicket | null>("get_ticket_detail", { p_ticket_id: ticketId, p_project_code: projectCode ?? null });

export const getDataQuality = (f: RpcFilters) => call<DataQuality>("get_data_quality", { p_filters: f });
export const getImportRuns = (limit = 50) => call<ImportRun[]>("get_import_runs", { p_limit: limit });
export const getImportRunDetail = (id: string) => call<ImportRunDetail | null>("get_import_run_detail", { p_run_id: id });
export const listAppUsers = () => call<AppUser[]>("list_app_users");
export const getAuditEvents = (limit = 100) => call<AuditEvent[]>("get_audit_events", { p_limit: limit });
export const getImportJobs = (limit = 50) => call<ImportJobListItem[]>("get_import_jobs", { p_limit: limit });
export const getImportJob = (id: string) => call<ImportJobDetail | null>("get_import_job", { p_job_id: id });
export const getImportJobIssues = (id: string, limit = 300) =>
  call<{ total: number; issues: ImportIssueRow[] }>("get_import_job_issues", { p_job_id: id, p_severity: null, p_limit: limit, p_offset: 0 });
