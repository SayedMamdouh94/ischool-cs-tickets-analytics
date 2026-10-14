# Data quality

Findings from the four initial exports (12,969 tickets), verified by `npm run db:validate` against every row of the original files and shown live on the **Data Quality** page.

## Reconciliation

| Project | Organization_ID | Rows in file | In database | Rejected |
| --- | --- | --- | --- | --- |
| DECI — 4th Intake | 1610 | 2,114 | 2,114 | 0 |
| DECI — Summer Intake | 1906 | 582 | 582 | 0 |
| DEMI — 3rd Intake | 1609 | 6,470 | 6,470 | 0 |
| DEMI — Summer Intake | 1939 | 3,803 | 3,803 | 0 |
| **Total** | | **12,969** | **12,969** | **0** |

All 12,969 Ticket_IDs are unique across files. Row-level SHA-256 hashes, status counts, missing values for all 19 fields, anomaly counts and duration medians/P90s match between the files and the database (62 automated checks).

## Findings and how they are handled

| Finding | Count | Classification | Handling |
| --- | --- | --- | --- |
| Status `completed` / `pending` / `rejected` | 12,908 / 58 / 2 | — | Stored as-is |
| Missing status | 1 | Error | Kept NULL, shown as "Missing status"; not counted as pending |
| `Priority` empty in every file | 12,969 | Missing information | No priority analysis; nothing inferred |
| `Affected_Student_ID` empty in every file | 12,969 | Missing information | Not used |
| Missing `Responded_At` (and responder) | 1,250 | Missing information | Excluded from response statistics, counted separately |
| Completed without `Responded_At` | 1,248 | Missing information | As above |
| Missing `Resolved_At` (and resolver) | 62 | Missing information | Excluded from resolution statistics |
| Completed without `Resolved_At` | 1 | Anomaly | Excluded from resolution statistics |
| `Resolved_At` earlier than `Responded_At` | 228 | Anomaly | Both durations remain valid relative to creation; flagged |
| Response and resolution at the same instant | 6,901 (53%) | Pattern | Indicates the "response" timestamp marks actioning, not a reply |
| Templated acknowledgement as response text | 12,896 (99.4%) | Pattern | Response time labeled "recorded"; never presented as human performance |
| Bulk resolution events (≥ 10 tickets in the same second) | 25 events, 916 tickets | Pattern | Durations of these tickets reflect batch closure |
| Repeat submissions (same student, session, topic) | 60 groups, 126 tickets | Pattern | Kept as separate tickets, reported |
| Timestamps with `+0200` / `+0300` offsets | 157 / 37,438 | — | All consistent with Africa/Cairo daylight saving (0 mismatches) |
| Multi-line free text | messages 4,216 · notes 9,732 · responses 48 | — | Preserved exactly |
| Attachment references | 1,751 request · 49 response | — | Normalized into `ticket_attachments`; never fetched |
| Session ID reused by different students | 0 of 5,322 | Structural | Session IDs are per-student bookings; recurrence measured per lesson |

Responder_Name and Resolved_By differ for a meaningful share of tickets and are always analyzed separately.

## What the data cannot answer

- Actual human first-response time (no reliable human-reply timestamp).
- Status history and true historical backlog (only the latest status per export; the backlog-over-time chart is reconstructed from timestamps and labeled as such).
- Priority, SLA compliance or satisfaction (not present).
- Root causes (topics are student-selected; themes are keyword-based indications).

## Ongoing monitoring

Each import stores file-level statistics in `import_runs.reconciliation`. After every import run `npm run db:validate`; the Data Quality page shows findings for any filter selection plus per-file reconciliation and import history.
