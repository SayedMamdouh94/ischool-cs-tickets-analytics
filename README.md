# CS Tickets Analytics

Customer-support ticket analytics for four educational projects — **DECI 4th Intake**, **DECI Summer Intake**, **DEMI 3rd Intake** and **DEMI Summer Intake** — built from historical ticket exports.

- **Next.js 16** (App Router, Cache Components, TypeScript strict) · Tailwind CSS v4 · shadcn/ui · Recharts
- **Supabase** PostgreSQL + Auth, Row Level Security, all analytics computed in SQL functions
- Admin **CLI importer** (idempotent, validated, fully reconciled against the source files)
- Deploys to **Vercel**

> This is an analytics system over imported exports, **not** a live ticketing system. Statuses reflect each export snapshot; the dashboard shows the snapshot date everywhere.

## What's inside

| Area | Where |
| --- | --- |
| 10 dashboard pages (overview, projects, trends, topics, team, backlog, explorer, data quality, insights, settings) + printable management summary | `src/app/(dashboard)/` |
| Database schema, RLS, analytics functions, reference data | `supabase/migrations/` |
| CSV parsing, validation, transformation, classification (pure, tested) | `src/lib/ingest/`, `src/lib/classification/`, `src/lib/validation/` |
| Import / validate / check / grant CLIs | `scripts/` |
| Unit + integration tests | `tests/` |
| Documentation | `docs/` |

## Quick start (local)

Prerequisites: Node 22+, Docker Desktop, Supabase CLI.

```bash
npm install
supabase start                 # local Postgres 17 + Auth on ports 553xx (see supabase/config.toml)
cp .env.example .env.local     # then fill in the values printed by `supabase status`
supabase db reset              # applies all migrations
# put the four CSV exports in data/raw/
npm run db:import              # idempotent import of all files in data/raw
npm run db:validate            # reconcile every row against the source files
npm run db:check               # security + health checks
npm run dev:users              # LOCAL ONLY: admin@local.test / analyst@local.test
npm run dev                    # http://localhost:3000
```

For local development `.env.local` uses the standard local-stack values:

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<PUBLISHABLE_KEY from `supabase status`>
SUPABASE_SECRET_KEY=<SECRET_KEY from `supabase status`>
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` / `lint` | TypeScript strict check / ESLint |
| `npm test` | Unit tests (includes full-file checks of `data/raw` when present) |
| `npm run test:integration` | Integration tests against the **local** Supabase stack (RLS, roles, SQL metric correctness, importer) |
| `npm run verify` | typecheck + lint + unit tests + production build |
| `npm run db:import [-- --dry-run \| --file <csv> \| --force-update]` | Import CSV exports |
| `npm run db:validate` | Reconcile database vs. original files (counts, hashes, statuses, missing values, anomalies, durations) |
| `npm run db:check` | Migrations, RLS, anon lockdown, column privileges, reference data, import status |
| `npm run db:reclassify` | Recompute rule-based issue themes after rule changes |
| `npm run admin:grant -- --email <e> [--role admin\|analyst] [--invite] [--revoke]` | Grant/revoke application roles |
| `npm run db:types` | Regenerate `src/types/database.ts` from the local schema |

## Access model

- Public sign-up is disabled; there is no public page with data.
- Users need an **application role** (`user_roles`) to see anything: **admin** (everything, including message text, exports, settings, access) or **analyst** (aggregates and ticket metadata; no message text, notes, attachments or ticket-level exports). Enforced in PostgreSQL, not only in the UI.
- Viewing ticket content, exports and settings changes are written to an audit log.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together
- [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) — tables, functions, security
- [docs/DATA_IMPORT.md](docs/DATA_IMPORT.md) — importing current and future exports
- [docs/METRIC_DEFINITIONS.md](docs/METRIC_DEFINITIONS.md) — every formula on the dashboard
- [docs/DATA_QUALITY.md](docs/DATA_QUALITY.md) — known issues in the exports and how they are handled
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Supabase + Vercel production setup
