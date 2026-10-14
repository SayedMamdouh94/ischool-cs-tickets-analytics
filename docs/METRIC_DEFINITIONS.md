# Metric definitions

All metrics are computed in PostgreSQL from the imported tickets that match the active filters. Durations are reported in seconds by the database and formatted in the UI (minutes, hours or days).

## Calendar and time zone

- Timestamps are stored as absolute instants (`TIMESTAMPTZ`).
- Dates, weekdays and hours use **Africa/Cairo** (`created_date`, `created_isodow`, `created_hour`). Weeks start on Monday.
- Date filters select tickets by **creation date** (Cairo), inclusive of both ends.
- Date presets (Last 7/30/90 days, This month) end at the **latest ticket date in the dataset** by default, because the data is a historical export. The anchor can be switched to "today" in Settings; the active anchor is always displayed in the date picker.

## Volume and status

| Metric | Definition |
| --- | --- |
| Tickets | Count of tickets (unique Ticket_ID). |
| Completed / Pending / Rejected | Count where `status` equals the value in the latest export. |
| Missing status | Count where `status` is NULL. Never counted as pending. |
| Completion rate | Completed ÷ all tickets (missing statuses stay in the denominator). |
| Unresolved | `resolved_at IS NULL` and status is `pending` or NULL. |
| Unique students | Distinct `owner_id`. |
| Response recorded (coverage) | Tickets with `responded_at` ÷ all tickets. |
| Resolution recorded (coverage) | Tickets with `resolved_at` ÷ all tickets. |
| Share | Group tickets ÷ tickets in view. |

## Recorded first response time

`response_duration = responded_at − created_at`

**Label: "recorded first response".** 99.4% of `Response` values are templated acknowledgements ("تم استلام طلبكم بنجاح…", "We have received your request…"), and `responded_at` equals `resolved_at` for 53% of tickets. The timestamp therefore marks when the ticketing system recorded a response — often when the ticket was actioned or closed — and **is not evidence of a human reply**. It must not be presented as agent performance. A genuine human first-response time cannot be derived from these exports.

## Resolution time

`resolution_duration = resolved_at − created_at`

A `completed` status does not imply a resolution timestamp exists; only tickets with a timestamp contribute.

## Duration statistics (both durations)

| Statistic | Definition |
| --- | --- |
| n | Tickets with a valid duration (timestamp present and duration ≥ 0). |
| Average | Arithmetic mean over n. |
| Median | `percentile_cont(0.5)` (linear interpolation). |
| P90 | `percentile_cont(0.9)`. |
| Missing | Tickets without the timestamp — excluded and reported separately. |
| Invalid | Negative durations — excluded and reported separately (none in current data). |

Durations for a person (Support Team page) are shown only when n ≥ 20.

## Thresholds (illustrative, not SLAs)

Defaults: recorded response 24 h, resolution 72 h — editable by administrators in Settings.

| Metric | Definition |
| --- | --- |
| Over response threshold | Tickets whose recorded response duration > threshold ÷ tickets with a valid response duration. |
| Over resolution threshold | Tickets whose resolution duration > threshold ÷ tickets with a valid resolution duration. |
| Unresolved over threshold | Unresolved tickets whose age at their project's **export snapshot** > resolution threshold. |

No contractual SLA, priority or satisfaction data exists in the exports; none is inferred.

## Backlog

- **Export snapshot** of a project = `data_as_of` of its latest successful import (latest timestamp in that file); fallback: latest timestamp in its tickets.
- **Age** of an unresolved ticket = snapshot − `created_at` (not "now", which would overstate ages of a stale export). Buckets: < 24 h, 1–3 d, 3–7 d, > 7 d.
- **Reconstructed open tickets** (historical chart) = cumulative tickets created by each Cairo day − cumulative tickets resolved by that day, using only tickets with a resolution timestamp. The exports contain no status history, so this is an approximation and is labeled as such; it is never mixed with current-status figures.

## Trends

- Volume series: tickets per creation day/week/month (Cairo); missing periods are shown as zero.
- **Period-over-period**: the selected range (or, with no range, the last 30 days of data) vs. the immediately preceding period of equal length.
- **Unusual days**: a day is flagged when its count ≥ 10 and its robust z-score `(count − median₂₈) / max(1.4826·MAD₂₈, √median₂₈)` ≥ 3.5, where median₂₈ and MAD₂₈ are computed over the previous 28 days and median₂₈ ≥ 5 (so the start of an intake is not flagged). Flags describe that volume rose, never why.

## Topics, categories and themes

- **Topic** — the source value chosen by the student; describes the request, not a verified cause.
- **Category** — analytical grouping of topics (`ticket_categories.source_topics`).
- **Issue theme** — primary keyword theme detected in the free-text details (`rules-v1`). "Structured request" = no free text; "Other / unmatched" = text present but no rule matched. Indicative only.
- **Recurring sessions** — sessions referenced by ≥ 2 different students. In the current exports a Session ID identifies one student's booking, so recurrence is read at lesson level (distinct students per lesson name).

## Insight rules

| Insight | Rule |
| --- | --- |
| Volume leader | Project with the most tickets in view, with its share. |
| Rising / falling topic | Current period ≥ 20 tickets and change ≥ ±50% vs. the previous period. |
| Slower topic | ≥ 30 resolved tickets and median resolution ≥ 1.25× the overall median. |
| Outstanding issues | Unresolved tickets by project, with counts over the threshold. |
| Dominant theme | A theme covering ≥ 40% of a topic with ≥ 100 tickets. |
| Lesson hotspots | Lessons referenced by ≥ 50 different students. |
| Unusual days | See trends. |
| Threshold breaches | Share of resolved tickets over the resolution threshold, by project. |
| Response caveat | Shown when > 50% of responses are templated acknowledgements. |
