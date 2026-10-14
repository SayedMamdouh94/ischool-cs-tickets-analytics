# Database schema

Migrations (apply in order with the Supabase CLI):

| File | Contents |
| --- | --- |
| `20261014090000_core_schema.sql` | Tables, generated columns, indexes, triggers |
| `20261014090100_security.sql` | Role helpers, RLS policies, grants, last-admin protection, audit helper |
| `20261014090200_reference_data.sql` | The four projects, categories and issue themes, default thresholds and settings |
| `20261014090300_analytics.sql` | Filtering primitives and all analytics / settings / access functions |

## Tables

### `projects`
`id uuid PK`, `code` (e.g. `DEMI_3RD`, unique), `name`, `program` (DECI/DEMI), `intake`, `intake_group` (Regular/Summer), `organization_id` (unique), `file_name_hint` (text expected in export filenames), `display_order`, `is_active`, timestamps. `unique (id, organization_id)` supports the composite foreign key from tickets.

### `tickets`
One row per source ticket. `ticket_id bigint PK` (source IDs are globally unique).

- **Original fields** (blank → NULL, free text verbatim): `topic`, `message`, `status`, `priority`, `department`, `owner_type`, `owner_id`, `affected_student_id`, `created_at`, `responded_at`, `resolved_at` (TIMESTAMPTZ), `response`, `note`, `responder_name`, `resolved_by`, `organization_id`, `attachment_urls`, `response_attachment_urls`.
- **Parsed from the message** (importer, `parser_version`): `sub_topic` (bilingual values normalized), `session_ref`, `lesson_name`, `message_language` (ar/en/mixed/none).
- **Derived**: `response_kind` (trigger: missing / generic_acknowledgement / automated / custom); generated `response_seconds`, `resolution_seconds`, `created_date`, `created_hour`, `created_isodow` (Africa/Cairo).
- **Lineage**: `source_filename`, `source_row_number`, `source_data_as_of`, `row_hash` (SHA-256 of the 19 raw values), `first_import_run_id`, `last_import_run_id`, `imported_at`, `updated_at`.
- **Integrity**: FK `(project_id, organization_id) → projects(id, organization_id)`; trigger `tickets_guard_project` raises `TICKET_ID_COLLISION` if an update would move a ticket to another project.

### `ticket_attachments`
Normalized attachment references: `ticket_id`, `attachment_type` (request/response), `position`, `url` (original), `url_host`, `file_name` (decoded), `file_extension`. URLs are never fetched.

### `import_runs`
One row per file per import attempt: file name and SHA-256, size, project, timestamps, `status` (running / completed / completed_with_errors / failed), `records_in_file`, `inserted_count`, `updated_count`, `skipped_unchanged_count`, `skipped_stale_count`, `skipped_count` (generated), `rejected_count`, `data_as_of` (latest timestamp in the file), created-date range, `duplicate_of_run_id`, `update_policy`, `importer_version`, `error_summary`, `reconciliation` (file-level statistics, no text). A check constraint guarantees `records = inserted + updated + skipped + rejected` for finished runs.

### `import_errors`
Rejected rows: `import_run_id`, `source_row_number`, `ticket_id`, `error_code` (e.g. `VALIDATION_FAILED`, `DUPLICATE_TICKET_IN_FILE`, `TICKET_ID_COLLISION`, `ORGANIZATION_MISMATCH`, `FILE_STRUCTURE_INVALID`, `PROJECT_MAPPING_FAILED`), `validation_error`, `raw_row` (jsonb, admin-only), `recorded_at`.

### `ticket_categories`
Analytical taxonomy. `kind = 'category'` rows group source topics (`source_topics text[]`); `kind = 'subcategory'` rows are cross-cutting issue themes detected from message text.

### `ticket_classifications`
Versioned derived classification: `ticket_id`, `category_id`, `subcategory_id`, `method` (rule_based / manual / ai_assisted), `confidence`, `version` (`rules-v1`), `evidence` (matched rule labels — never message text), `is_current` (one current row per ticket). The original `Topic` is never modified.

### `analytics_thresholds`, `app_settings`
Editable monitoring thresholds (`response_hours`, `resolution_hours`) and preferences (`date_preset_anchor`, `default_date_preset`, `organization_name`).

### `user_roles`, `audit_events`
`user_roles(user_id → auth.users, role admin|analyst)`; a trigger prevents removing the last administrator. `audit_events` records content views, exports, settings and access changes (identifiers and filters only).

## Security

| Object | anon | authenticated, no role | analyst | admin |
| --- | --- | --- | --- | --- |
| Any table | ✗ | rows hidden by RLS | read (see below) | read |
| `tickets.message/response/note/attachment_urls` | ✗ | ✗ (column grant) | ✗ (column grant) | via `get_ticket_detail` / export only |
| `ticket_attachments`, `import_errors.raw_row`, `audit_events` | ✗ | ✗ | ✗ | ✓ |
| Analytics functions | ✗ | error 42501 | ✓ | ✓ |
| `export_tickets_page`, settings and access functions | ✗ | ✗ | ✗ | ✓ |

All `public` functions are `SECURITY DEFINER` with `search_path = ''`, fully qualified names, and call `private.require_role()` first; `npm run db:check` verifies this, RLS on every table, and that `anon` has no privileges. Helpers live in the non-exposed `private` schema.

## Analytics functions (all return one jsonb value)

| Function | Used by |
| --- | --- |
| `get_my_access()` | session role |
| `get_filter_options()` | filter bar, dataset range, latest import |
| `get_grouped_metrics(filters, dimension, limit)` | KPIs and comparisons by none/project/program/intake/intake_group/topic/category/subcategory/responder/resolver/status/response_kind/lesson/month |
| `get_cross_tab(filters, row_dim, col_dim)` | topic × project, person × project, topic × theme |
| `get_volume_series(filters, grain, split)` | trends (day/week/month) |
| `get_weekday_hour(filters)` | heatmap |
| `get_duration_histogram(filters, metric, split)` | duration distributions |
| `get_backlog(filters, n)` | unresolved by age, oldest tickets, reconstructed backlog |
| `get_period_comparison(filters, dimension, days)` | period-over-period |
| `get_recurring_sessions(filters, min_students, n)` | recurrence |
| `search_tickets(filters, search, sort, dir, page, size)` | explorer |
| `get_ticket_detail(id)` | drawer / detail page (content for admins, audited) |
| `export_tickets_page`, `record_export` | CSV exports |
| `get_data_quality(filters)`, `get_import_runs`, `get_import_run_detail` | data quality, imports |
| `get_settings`, `update_threshold`, `update_app_setting`, `update_project`, `list_app_users`, `set_user_role`, `revoke_user_role`, `get_audit_events` | settings |

Filters are one jsonb object: `projects, programs, intakes, statuses, topics, responders, resolvers, categories, subcategories, response_kinds` (arrays), `date_from, date_to` (Cairo calendar dates, inclusive), `session_ref`, `lesson`. `__none__` matches NULL status/responder/resolver.

TypeScript types: `npm run db:types` → `src/types/database.ts`; payload types in `src/lib/analytics/types.ts`.
