# Database schema

Migrations (apply in order with the Supabase CLI):

| File | Contents |
| --- | --- |
| `20261014090000_core_schema.sql` | Tables, generated columns, indexes, triggers |
| `20261014090100_security.sql` | Role helpers, RLS policies, grants, last-admin protection, audit helper |
| `20261014090200_reference_data.sql` | The four projects, categories and issue themes, default thresholds and settings |
| `20261014090300_analytics.sql` | Filtering primitives and all analytics / settings / access functions |
| `20261024090000_lifecycle_and_identity.sql` | Reporting cycles, project lifecycle (draft/active/archived), internal ticket key, topic→category mapping table, status classes, insight rules, ticket change history, import jobs/staging/issues/events, private `imports` bucket, RLS for all of them |
| `20261024090100_scoped_analytics.sql` | Scope-aware analytics (one cycle, archived only on request), configurable open/closed statuses, coverage-aware period comparison, scope catalog, project-aware ticket detail and export |
| `20261024090200_admin_and_import_jobs.sql` | Project/cycle/category/status/insight-rule administration, the import-job lifecycle (admin), worker functions (service role), batched SQL applier, pg_cron scheduler + pg_net watchdog |

## Tables

### `reporting_cycles`
`id`, `code` (unique), `name`, `description`, `status` (draft / active / archived), `is_current` (at most one; must be active), `display_order`, archive metadata (`archived_at`, `archived_by`, `archive_reason`), `created_by`, timestamps. Analytics always cover exactly one cycle.

### `projects`
`id uuid PK`, `code` (e.g. `DEMI_3RD`, unique and permanent), `name`, `program` (any 2–20 capital letters/digits), `intake`, `intake_group` (free text), `organization_id` (unique among **active** projects only), `file_name_hint` (CLI file mapping), `display_order`, `description`, `cycle_id → reporting_cycles`, `status` (draft = hidden while an "archive & start new" import runs; active; archived = read-only history), archive metadata (`archived_via` project|cycle), `created_by`, timestamps. `unique (id, organization_id)` supports the composite foreign key from tickets.

### `tickets`
One row per source ticket **per project**. `id bigint PK` (internal identity); `ticket_id` is the source Ticket_ID, unique per project (`unique (project_id, ticket_id)`). The same source ID may exist in an archived project and in its replacement.

- **Original fields** (blank → NULL, free text verbatim): `topic`, `message`, `status`, `priority`, `department`, `owner_type`, `owner_id`, `affected_student_id`, `created_at`, `responded_at`, `resolved_at` (TIMESTAMPTZ), `response`, `note`, `responder_name`, `resolved_by`, `organization_id`, `attachment_urls`, `response_attachment_urls`.
- **Parsed from the message** (importer, `parser_version`): `sub_topic` (bilingual values normalized), `session_ref`, `lesson_name`, `message_language` (ar/en/mixed/none).
- **Derived**: `response_kind` (trigger: missing / generic_acknowledgement / automated / custom); generated `response_seconds`, `resolution_seconds`, `created_date`, `created_hour`, `created_isodow` (Africa/Cairo).
- **Lineage**: `source_filename`, `source_row_number`, `source_data_as_of`, `row_hash` (SHA-256 of the 19 raw values), `first_import_run_id`, `last_import_run_id`, `imported_at`, `updated_at`.
- **Integrity**: FK `(project_id, organization_id) → projects(id, organization_id)`; trigger `tickets_guard_project` raises `TICKET_ID_COLLISION` if an update would move a ticket to another project or change its source ID; trigger `tickets_record_changes` writes the previous values of changed source fields to `ticket_changes` whenever an import updates a ticket.

### `ticket_changes`
Field-level history: `ticket_pk`, `import_run_id`, `changed_at`, previous/new row hash and export date, `changes` jsonb (`{"Status": {"old": …, "new": …}}`). Admin-only (may contain message text); the ticket page shows field names to analysts and values to administrators.

### `ticket_attachments`
Normalized attachment references: `ticket_pk → tickets.id`, `attachment_type` (request/response), `position`, `url` (original), `url_host`, `file_name` (decoded), `file_extension`. URLs are never fetched.

### `import_runs`
One row per file per import attempt: file name and SHA-256, size, project, timestamps, `status` (running / completed / completed_with_errors / failed), `records_in_file`, `inserted_count`, `updated_count`, `skipped_unchanged_count`, `skipped_stale_count`, `skipped_count` (generated), `rejected_count`, `data_as_of` (latest timestamp in the file), created-date range, `duplicate_of_run_id`, `update_policy`, `importer_version`, `error_summary`, `reconciliation` (file-level statistics, no text). `source` (cli / web), `triggered_by`, `invalid_row_policy`. A check constraint guarantees `records = inserted + updated + skipped + rejected` for finished runs.

### `import_jobs`, `import_job_rows`, `import_job_issues`, `import_job_events`
Web import workflow (see DATA_IMPORT.md). `import_jobs` holds mode (upsert / archive_and_start), target and archive targets, the private storage path, validation summary and preview, the chosen invalid-row policy, the linked `import_run_id`, progress, lease (`lease_owner`, `lease_expires_at`), attempts and the last error. A partial unique index allows one `importing` job per project. `import_job_rows` stages parsed rows (normalized ticket record, attachments, rule-based theme, raw values of rejected rows) and has **no client privileges at all**. `import_job_issues` lists findings by severity/code/row/line/column (excerpts never contain free text). `import_job_events` is the per-job audit trail.

### `import_errors`
Rejected rows: `import_run_id`, `source_row_number`, `ticket_id`, `error_code` (e.g. `VALIDATION_FAILED`, `DUPLICATE_TICKET_IN_FILE`, `TICKET_ID_COLLISION`, `ORGANIZATION_MISMATCH`, `FILE_STRUCTURE_INVALID`, `PROJECT_MAPPING_FAILED`), `validation_error`, `raw_row` (jsonb, admin-only), `recorded_at`.

### `ticket_categories`, `topic_categories`
Analytical taxonomy. `kind = 'category'` rows group source topics; `kind = 'subcategory'` rows are cross-cutting issue themes detected from message text. `topic_categories(topic PK, category_id, source seed|admin)` maps each source Topic to a category; unmapped topics fall back to `uncategorized`.

### `ticket_statuses`
`status` (source value, `__none__` = missing) → `status_class` open|closed, `label`. Unlisted values count as open and are reported as unclassified.

### `insight_rules`
Configurable insight thresholds (`key`, `value`, `min_value`, `max_value`, `unit`, `label`, `description`).

### `ticket_classifications`
Versioned derived classification: `ticket_pk → tickets.id`, `category_id`, `subcategory_id`, `method` (rule_based / manual / ai_assisted), `confidence`, `version` (`rules-v1`), `evidence` (matched rule labels — never message text), `is_current` (one current row per ticket). The original `Topic` is never modified.

### `analytics_thresholds`, `app_settings`
Editable monitoring thresholds (`response_hours`, `resolution_hours`) and preferences (`date_preset_anchor`, `default_date_preset`, `organization_name`).

### `user_roles`, `audit_events`
`user_roles(user_id → auth.users, role admin|analyst)`; a trigger prevents removing the last administrator. `audit_events` records content views, exports, settings and access changes (identifiers and filters only).

## Security

| Object | anon | authenticated, no role | analyst | admin |
| --- | --- | --- | --- | --- |
| Any table | ✗ | rows hidden by RLS | read (see below) | read |
| `tickets.message/response/note/attachment_urls` | ✗ | ✗ (column grant) | ✗ (column grant) | via `get_ticket_detail` / export only |
| `ticket_attachments`, `import_errors.raw_row`, `audit_events`, `ticket_changes`, `import_jobs`, `import_job_issues`, `import_job_events` | ✗ | ✗ | ✗ | ✓ (read) |
| `import_job_rows` (staged rows) | ✗ | ✗ | ✗ | ✗ (no grants; worker only) |
| Storage bucket `imports` | ✗ | ✗ | ✗ | ✗ (signed upload URL issued after an admin check; service-role worker reads) |
| Analytics functions, `get_scope_catalog`, `get_topic_mappings`, `get_status_values`, `get_project_history` | ✗ | error 42501 | ✓ | ✓ |
| `export_tickets_page`, settings, access, project/cycle/category/status/insight-rule changes, import-job functions | ✗ | ✗ | ✗ | ✓ |
| `worker_*` functions | ✗ | ✗ | ✗ | ✗ (service role only) |

All `public` functions are `SECURITY DEFINER` with `search_path = ''`, fully qualified names, and call `private.require_role()` (or `private.require_service_role()` for worker functions) first; `npm run db:check` verifies this, RLS on every table, and that `anon` has no privileges. Helpers live in the non-exposed `private` schema.

## Analytics functions (all return one jsonb value)

| Function | Used by |
| --- | --- |
| `get_my_access()` | session role |
| `get_scope_catalog()` | cycle selector, per-project export dates |
| `get_filter_options(scope)` | filter bar, resolved scope, coverage per project, imports in progress, unmapped/unclassified counts |
| `get_grouped_metrics(filters, dimension, limit)` | KPIs and comparisons by none/project/program/intake/intake_group/topic/category/subcategory/responder/resolver/status/response_kind/lesson/month |
| `get_cross_tab(filters, row_dim, col_dim)` | topic × project, person × project, topic × theme |
| `get_volume_series(filters, grain, split)` | trends (day/week/month) |
| `get_weekday_hour(filters)` | heatmap |
| `get_duration_histogram(filters, metric, split)` | duration distributions |
| `get_backlog(filters, n)` | unresolved by age, oldest tickets, reconstructed backlog |
| `get_period_comparison(filters, dimension, days)` | period-over-period with per-project windows and exclusions |
| `get_recurring_sessions(filters, min_students, n)` | recurrence |
| `search_tickets(filters, search, sort, dir, page, size)` | explorer |
| `get_ticket_detail(id, project_code)` | drawer / detail page (content for admins, audited; ambiguous IDs return the candidates) |
| `export_tickets_page`, `record_export` | CSV exports |
| `get_data_quality(filters)`, `get_import_runs`, `get_import_run_detail` | data quality, imports |
| `get_settings`, `update_threshold`, `update_app_setting`, `update_insight_rule`, `list_app_users`, `set_user_role`, `revoke_user_role`, `get_audit_events` | settings |
| `create_reporting_cycle`, `update_reporting_cycle`, `set_current_cycle`, `archive_cycle`, `restore_cycle`, `create_project`, `update_project`, `archive_project`, `restore_project`, `get_project_history` | Projects tab |
| `get_topic_mappings`, `set_topic_category`, `upsert_category`, `get_status_values`, `set_status_class` | Categories tab |
| `create_import_job`, `mark_import_uploaded`, `refresh_import_preview`, `confirm_import_job`, `cancel_import_job`, `retry_import_job`, `get_import_jobs`, `get_import_job`, `get_import_job_issues` | Imports tab, job page |
| `worker_claim_job`, `worker_heartbeat`, `worker_set_file`, `worker_stage_rows`, `worker_finish_validation`, `worker_fail`, `worker_release`, `worker_apply_batch` | background worker (service role) |

Filters are one jsonb object: `cycle` (code; default = current cycle), `include_archived` (boolean), `projects, programs, intakes, statuses, topics, responders, resolvers, categories, subcategories, response_kinds` (arrays), `date_from, date_to` (Cairo calendar dates, inclusive), `session_ref`, `lesson`. `__none__` matches NULL status/responder/resolver.

Background driver: pg_cron job `cs-tickets-import-jobs` (every 15 s) calls `private.run_import_jobs()`, which applies confirmed imports batch by batch (COMMIT per batch), expires abandoned uploads, fails jobs that stop making progress, and nudges the web worker through `pg_net` using the Vault secrets `import_worker_url` / `import_worker_secret`.

TypeScript types: `npm run db:types` → `src/types/database.ts`; payload types in `src/lib/analytics/types.ts`.
