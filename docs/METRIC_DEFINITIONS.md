# Metric definitions

All metrics are computed in PostgreSQL from the imported tickets that match the active filters **within one reporting cycle**. Durations are reported in seconds by the database and formatted in the UI (minutes, hours or days).

## Scope (reporting cycles)

- Every page analyses exactly **one reporting cycle** — by default the cycle marked *current* in Settings → Projects. Cycles are never combined.
- Within the selected cycle only **active** projects are included. Archived projects appear only when the user switches on "Include archived projects" in the cycle selector (the page then says so). Selecting an archived cycle shows all of its (archived) projects as a historical view.
- Draft projects (an "Archive & start new" import still running) are never included anywhere.
- The URL carries the scope (`?cycle=CODE&archived=1`), so shared links reproduce the same view.

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
| Unresolved (open) | `resolved_at IS NULL` and the status is classified as **open** in Settings → Categories → Status values (by default `pending` and a missing status). A status value that has not been classified yet also counts as open — so it is never hidden — and is flagged in Data Quality and Insights until an administrator classifies it. `completed` and `rejected` are closed. |
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
- **Period-over-period** respects each project's data coverage, because projects are exported on different dates:
  - *No date range selected* (default): every project is compared over **its own** latest N complete days (ending the day before its export snapshot; N = 30, configurable as "Trend comparison window") versus the N days before that.
  - *Date range selected*: one calendar window for everyone, compared with the preceding window of equal length.
  - In both modes a project is **excluded** from the comparison (and the exclusion is shown) when it had no tickets yet at the start of the previous window (an intake launch would look like growth) or, for a calendar window, when its export ends before the window ends.
  - The page states the exact windows per project.
- **Unusual days** are detected **per project**: a day is flagged when the project's count ≥ 10 (configurable) and its robust z-score `(count − median₂₈) / max(1.4826·MAD₂₈, √median₂₈)` ≥ 3.5 (configurable), where median₂₈ and MAD₂₈ are computed over that project's previous 28 days and median₂₈ ≥ 5. The first 21 days after a project's first ticket (configurable "Intake ramp-up period") and the partial last export day are never flagged. Combining projects would let one intake's launch look like an incident. Flags describe that volume rose, never why.

## Topics, categories and themes

- **Topic** — the source value chosen by the student; describes the request, not a verified cause.
- **Category** — analytical grouping of topics (`topic_categories`, maintained by administrators in Settings → Categories; changes reclassify existing tickets immediately). Unmapped topics are counted as "Uncategorized" and flagged.
- **Issue theme** — primary keyword theme detected in the free-text details (`rules-v1`). "Structured request" = no free text; "Other / unmatched" = text present but no rule matched. Indicative only.
- **Recurring sessions** — sessions referenced by ≥ 2 different students. In the current exports a Session ID identifies one student's booking, so recurrence is read at lesson level (distinct students per lesson name).

## Insight rules

Every insight is labelled **Observation** (describes the data), **Recommendation** (adds a suggested next step grounded in the evidence) or **Data caveat** (limits how figures should be read). No insight asserts a cause. All thresholds below are defaults stored in `insight_rules` and editable by administrators in Settings → Thresholds; insights are recomputed on every page load, so they follow new imports and disappear when their condition no longer holds.

| Insight | Kind | Rule (defaults) |
| --- | --- | --- |
| Volume distribution | Observation | Project with the most tickets in view, its share, and tickets per student for every project. |
| Topic taking a larger / smaller share | Recommendation / Observation | Compares the topic's **share of all tickets** in the latest vs. preceding period (per-project windows, see Trends), so overall growth is not mistaken for a topic trend. Reported when the topic has ≥ 20 tickets (current, or previous for falling), its share changed by ≥ 50%, and a two-proportion z-test reaches \|z\| ≥ 1.96. Ranked by \|z\|. The card explains the windows and exclusions. |
| Trend comparison unavailable | Data caveat | No project in view has complete data for both periods. |
| Slower topic | Recommendation | ≥ 30 resolved tickets and median resolution ≥ 1.25× the overall median; ranked by tickets affected. |
| Outstanding issues | Observation / Recommendation | Unresolved tickets and open rate by project, with counts over the resolution threshold (recommendation when any are over it). |
| Dominant theme | Recommendation | A theme covering ≥ 40% of a topic with ≥ 100 tickets; ranked by matching tickets (not alphabetically). |
| Recurring sessions / lesson hotspots | Observation / Recommendation | Sessions reported by ≥ 2 students; lessons referenced by ≥ 50 students. |
| Unusual days | Recommendation | Per-project spikes (see Trends). |
| Threshold breaches | Observation | Share of resolved tickets over the resolution threshold (watch > 20%, attention > 50%), by project. |
| Outdated exports | Data caveat | A project's export ends ≥ 7 days before the newest export in view. |
| Import in progress / stopped part-way / rejected rows | Data caveat | From the import jobs and latest runs of projects in view. |
| Unmapped topics / unclassified statuses / empty projects | Data caveat | Counts in view; links to Settings → Categories. |
| Response caveat | Data caveat | Shown when > 50% of responses are templated acknowledgements. |
