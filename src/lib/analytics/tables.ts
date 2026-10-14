import type { TableColumn, TableData } from "@/lib/table-data";
import { keyLabel } from "@/lib/format";
import type { GroupMetrics } from "./types";

export type MetricColumn =
  | "tickets"
  | "share"
  | "completed"
  | "pending"
  | "rejected"
  | "missing_status"
  | "open_tickets"
  | "completion_rate"
  | "response_coverage"
  | "resolution_coverage"
  | "response_median_s"
  | "response_p90_s"
  | "resolution_median_s"
  | "resolution_avg_s"
  | "resolution_p90_s"
  | "resolution_n"
  | "response_n"
  | "response_breach_rate"
  | "resolution_breach_rate"
  | "open_breaches"
  | "unique_owners"
  | "with_note";

const COLUMN_DEFS: Record<MetricColumn, TableColumn> = {
  tickets: { key: "tickets", label: "Tickets", kind: "int" },
  share: { key: "share", label: "Share", kind: "pct" },
  completed: { key: "completed", label: "Completed", kind: "int" },
  pending: { key: "pending", label: "Pending", kind: "int" },
  rejected: { key: "rejected", label: "Rejected", kind: "int" },
  missing_status: { key: "missing_status", label: "Missing status", kind: "int" },
  open_tickets: { key: "open_tickets", label: "Unresolved", kind: "int" },
  completion_rate: { key: "completion_rate", label: "Completion rate", kind: "pct" },
  response_coverage: { key: "response_coverage", label: "Response recorded", kind: "pct" },
  resolution_coverage: { key: "resolution_coverage", label: "Resolution recorded", kind: "pct" },
  response_median_s: { key: "response_median_s", label: "Median recorded response", kind: "duration" },
  response_p90_s: { key: "response_p90_s", label: "P90 recorded response", kind: "duration" },
  resolution_median_s: { key: "resolution_median_s", label: "Median resolution", kind: "duration" },
  resolution_avg_s: { key: "resolution_avg_s", label: "Average resolution", kind: "duration" },
  resolution_p90_s: { key: "resolution_p90_s", label: "P90 resolution", kind: "duration" },
  resolution_n: { key: "resolution_n", label: "Resolved (n)", kind: "int" },
  response_n: { key: "response_n", label: "Responded (n)", kind: "int" },
  response_breach_rate: { key: "response_breach_rate", label: "Over response threshold", kind: "pct" },
  resolution_breach_rate: { key: "resolution_breach_rate", label: "Over resolution threshold", kind: "pct" },
  open_breaches: { key: "open_breaches", label: "Unresolved over threshold", kind: "int" },
  unique_owners: { key: "unique_owners", label: "Unique students", kind: "int" },
  with_note: { key: "with_note", label: "With agent note", kind: "int" },
};

const div = (a: number, b: number) => (b > 0 ? a / b : null);

export function metricsTable(
  rows: GroupMetrics[],
  firstColumnLabel: string,
  columns: MetricColumn[],
  opts: { total?: number; labelFor?: (row: GroupMetrics) => string } = {},
): TableData {
  const total = opts.total ?? rows.reduce((a, r) => a + r.tickets, 0);
  return {
    columns: [{ key: "label", label: firstColumnLabel }, ...columns.map((c) => COLUMN_DEFS[c])],
    rows: rows.map((r) => ({
      key: r.key,
      label: opts.labelFor ? opts.labelFor(r) : keyLabel(r.label),
      tickets: r.tickets,
      share: div(r.tickets, total),
      completed: r.completed,
      pending: r.pending,
      rejected: r.rejected,
      missing_status: r.missing_status,
      open_tickets: r.open_tickets,
      completion_rate: div(r.completed, r.tickets),
      response_coverage: div(r.with_response_ts, r.tickets),
      resolution_coverage: div(r.with_resolution_ts, r.tickets),
      response_median_s: r.response_median_s,
      response_p90_s: r.response_p90_s,
      resolution_median_s: r.resolution_median_s,
      resolution_avg_s: r.resolution_avg_s,
      resolution_p90_s: r.resolution_p90_s,
      resolution_n: r.resolution_n,
      response_n: r.response_n,
      response_breach_rate: div(r.response_breaches, r.response_n),
      resolution_breach_rate: div(r.resolution_breaches, r.resolution_n),
      open_breaches: r.open_breaches,
      unique_owners: r.unique_owners,
      with_note: r.with_note,
    })),
  };
}
