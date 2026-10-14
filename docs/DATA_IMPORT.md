# Data import

Imports run from an administrator's machine with the CLI — never through the web app.

## Prerequisites

- `DATABASE_URL` in `.env.local` pointing at the target database (Supabase **Session pooler** on port 5432, or the direct connection). The transaction pooler (6543) is refused because the importer uses transactions and a session advisory lock.
- The CSV exports in `data/raw/` (git-ignored). Each file must contain the 19 standard columns.

## Commands

```bash
npm run db:import -- --dry-run          # parse + validate only; nothing is written
npm run db:import                       # import every *.csv in data/raw
npm run db:import -- --file "path.csv"  # import specific file(s)
npm run db:validate                     # reconcile database vs. files (exit 1 on mismatch)
npm run db:check                        # security and health checks
```

## Pipeline

1. **Discover** `*.csv` files and compute each file's SHA-256.
2. **Parse** strictly (RFC 4180): UTF-8 with BOM, quoted fields containing commas, quotes and newlines (CRLF/LF). Invalid UTF-8, wrong headers or ragged rows reject the file.
3. **Map to a project.** The filename hint (`projects.file_name_hint`, e.g. "DEMI 3rd Intake") selects the project if that project's Organization_ID covers most rows; otherwise the file must contain exactly one known Organization_ID. Conflicts reject the file (`PROJECT_MAPPING_FAILED`). Rows with a different Organization_ID are rejected individually (`ORGANIZATION_MISMATCH`).
4. **Validate** every row with Zod (`src/lib/validation/ticket-row.ts`): Ticket_ID positive integer, Topic present, Created_At present, all timestamps strictly `YYYY-MM-DD HH:MM:SS ±HHMM` with a valid calendar date, Organization_ID numeric. Failures are logged (`VALIDATION_FAILED`) with the reason and raw row.
5. **Normalize.** Blank values → NULL. Identifiers and categorical values are trimmed; message, response, note and attachment fields are stored **byte-for-byte**. Status is kept as-is (a missing status stays NULL). Timestamps keep their absolute instant (`+0200` / `+0300` honored) and are checked against Africa/Cairo daylight-saving rules.
6. **Derive** message structure (sub topic, session ID, lesson, language), attachment references and the rule-based classification. Derived fields never replace the originals.
7. **Detect duplicates**: within a file (the row with the latest activity is kept, others logged as `DUPLICATE_TICKET_IN_FILE`), across files in one run (`DUPLICATE_TICKET_ACROSS_FILES` / `TICKET_ID_COLLISION`) and against the database — a Ticket_ID that already belongs to another project is rejected (`TICKET_ID_COLLISION`) and a trigger blocks any attempt to move it.
8. **Write** in transactions of 500 rows (configurable `--batch-size`), retrying transient errors (connection resets, serialization failures, deadlocks) with exponential backoff. A session advisory lock prevents two imports from running at once; runs left `running` by a crash are marked failed on the next start.
9. **Record** the run in `import_runs` (counts + file-level reconciliation statistics) and rejected rows in `import_errors`, then print a summary.

## Idempotency and update policy

Each source row is hashed (SHA-256 of the 19 raw values). For a ticket that already exists in the same project:

| Situation | Action |
| --- | --- |
| Same hash | **unchanged** — nothing written |
| Different content, and this file's `data_as_of` ≥ the `source_data_as_of` stored on the ticket | **updated** (newer or equal export wins; `first_import_run_id` and `imported_at` are kept) |
| Different content, but this file is older than the export that last wrote the ticket | **skipped (stale)** — never overwrite newer data with an older export |

`data_as_of` is the latest timestamp found anywhere in the file, a proxy for the export time. `--force-update` disables the stale check (use only to deliberately restore an older export). Re-running the same files produces 0 inserted, 0 updated, all unchanged — verified by the integration tests. Imported timestamps are never treated as new activity: `created_at` is the source Created_At, not the import time.

## Importing future exports

1. Download the new exports and place them in `data/raw/` (replace or add; the filename should contain the project's hint, e.g. `DEMI Summer Intake Edu Tickets 2026-11.csv`).
2. `npm run db:import -- --dry-run` and review rejected rows, if any.
3. `npm run db:import`, then `npm run db:validate`.
4. Review **Settings → Imports** and **Data Quality** in the dashboard.

New tickets are inserted, changed tickets updated, and tickets absent from a newer export are kept (exports are treated as snapshots, not deletions).

**Adding a new project:** add a migration inserting it into `projects` (code, name, program, intake, intake_group, organization_id, file_name_hint) and, if it introduces new topics, map them in `ticket_categories.source_topics` (unmapped topics are classified as `uncategorized` until then).

## Classification

`rules-v1` (`src/lib/classification/rules.ts`): category from the topic mapping; issue theme from bilingual keyword rules applied to the free-text details after Arabic normalization (alef/ya/ta-marbuta variants, diacritics, tatweel, Arabic-Indic digits). Evidence stores matched rule labels, never text. After editing the rules, bump `CLASSIFICATION_VERSION` and run `npm run db:reclassify`; previous versions remain in `ticket_classifications` with `is_current = false`.

## Privacy

The CLI never prints message contents. Validation messages contain field names and, for timestamps, the offending value only. Raw rejected rows are stored in `import_errors.raw_row`, readable by administrators only.
