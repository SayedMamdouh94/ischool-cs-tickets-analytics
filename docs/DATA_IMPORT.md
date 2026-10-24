# Data import

Routine imports are done **in the dashboard** by an administrator: Settings & Imports → Imports. No terminal, SQL or redeployment is needed. The command-line importer remains available for bulk re-imports of the original files (see the end of this page).

## Template

Settings & Imports → Imports → **Import template**:

- **Excel (.xlsx)** — sheet `Tickets` with the 19 columns of the original export in the original order (the only sheet that is imported), `Instructions` (steps, rules, every column with required/recommended/optional, format, example), `Examples` (valid sample rows, never imported) and `Lists` (configured statuses, known topics). Every column is formatted as Text so Excel never rounds IDs or reformats dates. Choosing a project adds its details and an Organization_ID check.
- **CSV (.csv)** — the header row only, UTF-8 with BOM so Excel shows Arabic correctly.

Columns (unchanged from the export): `Ticket_ID`*, `Topic`*, `Message`, `Status`, `Priority`, `Department`, `Owner_Type`, `Owner_ID`, `Affected_Student_ID`, `Created_At`*, `Responded_At`, `Resolved_At`, `Response`, `Note`, `Responder_Name`, `Resolved_By`, `Organization_ID`*, `Attachment_URLs`, `Response_Attachment_URLs` (* required). `Organization_ID` may be left empty: it is filled with the selected project's value. Example rows carry the marker `TEMPLATE EXAMPLE - DO NOT IMPORT`; any row containing it is rejected even if it was copied into the data sheet.

## Workflow

1. **Choose the mode**
   - **Add / update an existing project** — the export is merged into an active project.
   - **Archive & start new** — archive one project (single intake) or a whole reporting cycle and load the file into a fresh project (and, for a cycle, a fresh cycle that becomes current).
2. **Upload** a `.xlsx` or `.csv` (≤ 50 MB). The browser sends the file directly to the private Storage bucket `imports` with a single-use signed URL (2 h, one path); it never passes through a web request body. A progress bar shows the upload.
3. **Validation** (background worker, nothing is written to tickets): file type, encoding, delimiter, template columns, required values, formats, duplicates, organization, Arabic text integrity, attachment URLs, conflicts with stored tickets. The job page shows progress and then the **preview**.
4. **Review**: new / updated / unchanged / older-export / invalid counts, warnings, fields that would change, conflicts, tickets in the project that are not in the file (kept), and every finding by row, line and column. **Download validation report** gives the full list as CSV.
5. **Confirm** with an explicit policy for invalid rows:
   - *All or nothing* — only possible when every row is valid.
   - *Import valid rows only* — must be selected explicitly when invalid rows exist; rejected rows are stored with their reasons (`import_errors`) and shown in the report. Nothing is discarded silently.
   If the data changed since the preview (for example another import finished), confirmation is refused, the preview is recomputed, and you confirm again.
6. **Import** runs in small atomic batches in the background; you can close the browser. The job page shows progress and then the **import report**. Dashboards, insights and data quality use the new data immediately.

Job states: `Waiting for upload → Uploaded → Validating → Ready for confirmation → Importing → Completed` (or `Completed with rejected rows`), or `Failed` / `Cancelled`. Every transition is recorded on the job (activity list) and in the audit log.

## Validation rules

| Kind | Checks |
| --- | --- |
| **File (blocking)** | `.csv` or `.xlsx` only, ≤ 50 MB, not empty, valid UTF-8 (Excel "CSV (Comma delimited)" in Windows-1256 is refused with instructions — save as "CSV UTF-8"), not UTF-16, not a workbook renamed to .csv, CSV structure (quotes, column counts), all 19 template columns present (case/spacing variants such as `ticket id` are accepted; extra columns are ignored with a warning), at least one data row, and most rows must carry the selected project's Organization_ID (otherwise the file belongs to another project). Comma, semicolon and tab delimiters are detected. In a workbook only the `Tickets` sheet (or the first data sheet) is read. |
| **Row (blocking — row rejected)** | Ticket_ID whole number ≤ 15 digits; Topic and Created_At present; timestamps valid (real calendar date, valid offset); Organization_ID numeric and equal to the project's; Status format; duplicate Ticket_ID in the file (the row with the latest activity is kept); Ticket_ID already belonging to another active project of the same cycle; template example rows; text containing `�` (corrupted before upload); identifiers that Excel stored as numbers and may have rounded (> 15 digits). |
| **Warning (imported, flagged)** | Status not yet classified as open/closed; new topic not mapped to a category; timestamps out of order; future timestamps; UTC offset not matching Cairo time on that date; completed without Resolved_At / pending with Resolved_At; garbled Arabic (mojibake); control characters; attachment values that are not http(s) URLs; updates that remove information (e.g. clear Resolved_At); rows from an older export than the stored ticket (not applied). |
| **Note** | Timestamps converted from ISO-8601 (`2026-09-01T10:15:00+03:00`) or read as Africa/Cairo time because they had no offset (including Excel date cells); Organization_ID filled from the project. Day/month formats such as `01/09/2026` are never guessed — they are errors. |

## Update policy (idempotent)

Each source row is hashed (SHA-256 of the 19 values after normalization; original-format values are hashed byte-for-byte, so files already imported by the CLI are recognised as unchanged). For a ticket that already exists in the target project:

| Situation | Action |
| --- | --- |
| Same hash | **unchanged** — nothing written |
| Different content and this file's `data_as_of` ≥ the stored ticket's | **updated**; previous values are kept in `ticket_changes` (shown in the ticket's history); `first_import_run_id` and `imported_at` are kept |
| Different content but this file is older | **older export (not applied)** |

`data_as_of` is the latest timestamp anywhere in the file. Tickets missing from a later export are **kept** (exports are snapshots, not deletions). Re-importing the same file changes nothing.

## Projects, cycles and archiving

- **Projects** (Settings → Projects) have a code (permanent), name, program (DECI, DEMI or any new program), intake, intake group, Organization_ID and description. An Organization_ID can belong to only one *active* project. It can change only while the project has no tickets.
- **Reporting cycles** group projects analysed together. Exactly one cycle is *current* (the dashboard default). Cycles are never combined in analytics.
- **Archiving** (a project or a whole cycle, with typed confirmation) never deletes anything: tickets, history and import records are kept; archived data is read-only for imports, hidden from the default dashboard, and available through the cycle selector (history view). Archived projects/cycles can be restored; restoring is refused while another active project uses the same Organization_ID.
- **Archive & start new** is atomic from the user's point of view: the new project is created as a hidden *draft* when you confirm, the file is imported into it, and only when every batch has succeeded is the old project/cycle archived and the new one activated (in one transaction). If the import fails, the old data stays active; you can retry (resumes) or cancel (discards the never-activated draft).
- Source Ticket_IDs are unique **per project**. The same ID may therefore exist in an archived project and its replacement; the ticket page asks which one to open.

## Background processing and reliability

- The worker (`/api/imports/worker`, service role, never a user session) parses and validates files and stages rows in idempotent chunks; validation resumes where it stopped.
- Confirmed imports are applied in atomic batches of 500–1,000 rows, either by the web worker or by **pg_cron every 15 seconds** directly in PostgreSQL — no HTTP needed — so an import continues even if the browser and the web function stop.
- Each job holds a 90-second lease (renewed per batch); an expired lease is picked up by the next run. After 5 consecutive attempts without progress the job is marked **Failed** with the error, never left hanging. A failed import can be retried and resumes after the last committed batch.
- Files waiting for validation while no browser is open are nudged by pg_cron through `pg_net` → `/api/imports/worker` (bearer secret, see DEPLOYMENT.md). While the job page is open it also restarts a stalled worker.
- Concurrency: one running import per project (unique index); a project cannot be archived or restored, and a cycle cannot be archived, while an import affects it; the CLI importer refuses to run during a web import and vice versa.
- Uploads awaiting completion for 24 hours are cancelled automatically. Staged rows are deleted when an import completes; the original file stays in the private bucket for the audit trail.

## Command-line importer (bulk / disaster recovery)

```bash
npm run db:import -- --dry-run          # parse + validate only
npm run db:import                       # import every *.csv in data/raw into ACTIVE projects (mapped by file name + Organization_ID)
npm run db:import -- --file "path.csv"  # specific file(s)
npm run db:validate                     # reconcile database vs. original files
```

It shares the validation code with the web importer, writes `import_runs` with `source = 'cli'`, and records field history through the same trigger. Without `DATABASE_URL` it uses the passwordless Supabase CLI transport (see DEPLOYMENT.md).

## Classification

`rules-v1` (`src/lib/classification/rules.ts`): category from the topic mapping (`topic_categories`); issue theme from bilingual keyword rules applied to the free-text details after Arabic normalization. Evidence stores matched rule labels, never text. After editing the rules, bump `CLASSIFICATION_VERSION` and run `npm run db:reclassify`.

## Privacy

Uploaded files are private (no storage policies; only signed upload URLs and the service-role worker). Staged rows are not readable by any client role. Issue excerpts never contain message, response or note text. Raw rejected rows are stored in `import_errors.raw_row`, readable by administrators only. Student messages are never sent to any external service.
