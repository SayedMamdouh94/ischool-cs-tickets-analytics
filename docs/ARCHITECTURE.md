# Architecture

## Overview

```
            CSV exports (data/raw)                         Browser (admin / analyst)
                    │                                               │  HTTPS, session cookie
                    ▼                                               ▼
   ┌───────────────────────────────┐              ┌──────────────────────────────────┐
   │ Admin CLI (scripts/, tsx)     │              │ Next.js on Vercel                 │
   │  parse → validate → transform │              │  proxy.ts: refresh session,       │
   │  → classify → batch upsert    │              │            redirect anonymous     │
   │  validate / check / grant     │              │  Server Components: DAL verifies  │
   └──────────────┬────────────────┘              │   JWT + role, calls SQL functions │
                  │ DATABASE_URL (privileged,     │  Client Components: charts,       │
                  │ never deployed)               │   filters, tables (data via props)│
                  ▼                               └────────────────┬─────────────────┘
   ┌───────────────────────────────────────────────────────────────▼─────────────────┐
   │ Supabase                                                                          │
   │  Auth (invite-only)   PostgreSQL 17: tables + RLS + column grants                 │
   │                        private.* helpers (not exposed)                            │
   │                        public.* analytics functions (SECURITY DEFINER, role check)│
   └───────────────────────────────────────────────────────────────────────────────────┘
```

## Key decisions

**One database, explicit project identity, reporting cycles.** All projects of all cycles live in one schema (no separate Supabase project per intake). Projects belong to a reporting cycle and have a lifecycle (draft → active → archived); analytics cover exactly one cycle at a time and include archived projects only on explicit request. `projects` holds program, intake, intake group and Organization_ID; `tickets.project_id` + `organization_id` reference `projects (id, organization_id)` as a pair, so a ticket's organization can never disagree with its project.

**Aggregation in PostgreSQL.** Every number on the dashboard comes from SQL functions in `supabase/migrations/*_analytics.sql`. The server receives aggregates (or one page of explorer rows), never the full ticket table. KPI totals are never computed by fetching tickets.

**Three layers of access control.**
1. `src/proxy.ts` refreshes the Supabase session and redirects anonymous requests to `/login` (API routes get 401).
2. The data access layer (`src/lib/auth/dal.ts`) verifies the JWT with `getClaims()` and loads the role; every page, server action and route handler calls it.
3. PostgreSQL enforces everything again: RLS on every table, column-level grants that hide free text from direct reads, and every RPC function starts with `private.require_role(...)`. Anonymous users have no table or function privileges at all.

**Server-only data access.** The browser never creates a Supabase client; the publishable key is only used server-side. The secret key is optional and used only to send invitations, after an admin check.

**Web imports without large request bodies.** Administrators upload `.xlsx`/`.csv` files from the browser straight to a private Storage bucket via a single-use signed URL. A background worker (Next.js route `/api/imports/worker`, service role) downloads, parses and validates the file and stages rows in PostgreSQL in idempotent chunks within a 45-second budget per invocation, continuing in a new invocation when needed. After the administrator confirms the preview, rows are applied by an atomic SQL batch function, driven either by the worker or by pg_cron every 15 seconds. Durable state, leases and attempt counters live in `import_jobs`, so no step depends on a browser staying open. The admin CLI importer remains for bulk re-imports.

```
 Browser (admin) ──signed PUT──▶ Storage "imports" (private)
      │ server actions (admin check)            ▲ download (service role)
      ▼                                         │
 Next.js ──create/confirm (RPC, admin)──▶ import_jobs ◀── worker route (validate → stage rows → preview)
                                              │
                                              ▼ confirm
                     pg_cron every 15 s / worker ──▶ private.apply_import_batch (atomic) ──▶ tickets
```

**Cache Components.** Pages render a static shell (header, filter skeletons) and stream request-specific content inside `<Suspense>`. The Supabase server client calls `connection()`, so session-bound data is always rendered per request and never shared between users. Per-request memoization (`React.cache`) deduplicates identical SQL calls within a render.

**Filters in the URL.** All global filters are query parameters (`src/lib/filters/schema.ts`, validated with Zod), so views are shareable and every chart, KPI, table and export reads the same slice. Filter changes run in a React transition: previous results stay visible (dimmed) until the new data arrives.

**Time zone.** Instants are stored as `TIMESTAMPTZ` (source offsets +0200/+0300 preserved as absolute time). Calendar attributes (`created_date`, `created_hour`, `created_isodow`) are generated columns in `Africa/Cairo`; the UI formats all times in Africa/Cairo.

**Deterministic insights.** `src/lib/analytics/insights.ts` turns SQL aggregates into observations, recommendations and data caveats with administrator-configurable thresholds (`insight_rules`), evidence and comparison method. Trends compare topic shares over each project's own data coverage; spikes are detected per project. No AI service is used and no ticket text leaves the database. Rule-based issue themes (`src/lib/classification/rules.ts`) run locally in the importer.

## Source layout

```
src/
  app/                  routes (login, auth/confirm, (dashboard)/*, api/export/*)
  components/
    charts/             Recharts wrappers (trend, bar list, columns, heatmap) + palette
    dashboard/          page frame, KPI cards, chart card (chart/table toggle, PNG/CSV), tables
    filters/            filter bar, multi-select, date range, URL-backed toggles
    tickets/            explorer table, drawer, detail view
    settings/           projects panel, import wizard, job monitor, categories, forms
    ui/                 shadcn/ui
  lib/
    analytics/          typed RPC wrappers, insights, anomalies, stats, shaping
    auth/               DAL, server actions, redirect safety
    classification/     keyword rules (Arabic + English)
    filters/            filter schema, date presets, URL serialization
    imports/            web import: template, upload reading (CSV/XLSX), validation, worker, actions, report
    ingest/             CSV parsing, timestamps, message parsing, attachments, transform
    supabase/           server / admin clients
    validation/         Zod schema for source rows
  proxy.ts              session refresh + auth redirect
scripts/                import, validate, check, reclassify, grant-role, worker-config, seed-local-users
supabase/migrations/    schema, security, reference data, analytics
tests/unit, tests/integration
```

## Charts

The categorical palette (one fixed color per project, `src/components/charts/colors.ts`) and the status palette were validated for color-vision deficiency in light and dark mode. Every chart card has a table view and CSV download, so no value is reachable only through color or hover; charts can also be downloaded as PNG.

## Performance notes

All analytics functions run in roughly 5–300 ms on the current 12,969 tickets (local Postgres 17). Indexes cover project/date, status, topic, responder, resolver, owner, session and unresolved tickets, plus a trigram index for admin full-text search. The explorer is server-paginated (max 100 rows per page). For much larger volumes, the next step would be materialized daily aggregates refreshed by the importer.
