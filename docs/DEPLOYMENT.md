# Deployment (Supabase + Vercel)

Target Supabase project: `https://rpofhzcqcxpuotsebzsq.supabase.co` (project ref `rpofhzcqcxpuotsebzsq`).

> Never paste keys or database passwords into chat, issues or source files. Put them in `.env.local` (git-ignored), your shell session, or Vercel's environment settings.

## 0. Prerequisites

- Node 22+, Supabase CLI ≥ 2.118, Vercel CLI, Git, a GitHub account.
- **Supabase CLI logged in to an account that is a member of the target project.** Check with:

  ```bash
  supabase projects list            # rpofhzcqcxpuotsebzsq must appear
  supabase login                    # if it does not: log in with the owning account (or get invited to its organization)
  ```

## 1. Automated finish (recommended): `npm run production:finish`

Everything after the migrations is automated and idempotent — no dashboard visits, no database password:

```bash
supabase login                               # once, as an account with access to the project
ENV_FILE=.env.cloud npm run production:finish
```

`.env.cloud` (git-ignored, mode 600, excluded from Vercel uploads) needs `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` and `NEXT_PUBLIC_SITE_URL`; optionally `ADMIN_EMAIL` (the administrator to provision) and `DATABASE_URL` (only if you prefer a direct connection). The API keys can be written into the file straight from the CLI without displaying them:

```bash
supabase projects api-keys --project-ref <ref> --reveal -o json   # pipe into the file; never print
```

| Step | What it does | Re-run behaviour |
| --- | --- | --- |
| 1. access | Queries the project through the CLI login; checks the site responds | read-only |
| 2. auth settings | `site_url`, redirect allow-list (existing entries kept), `disable_signup = true` via `supabase config diff/push` with a temporary config that declares only these keys | pushes only when different |
| 3. preflight | Read-only inventory: tables, rows, migration history | read-only |
| 4. import | `db:import --skip-known-files` | files already imported cleanly are skipped |
| 5. validate | 62 reconciliation checks against the original CSVs | read-only |
| 6. health | RLS, grants, anon lockdown, demo-account check | read-only |
| 7. administrator | `ADMIN_EMAIL` gets the admin role (invited first if the account doesn't exist) | no change if already admin |
| 8. permissions | Temporary admin / analyst / no-role accounts exercise RLS and role checks, then are removed | leaves no accounts |
| 9. live | Signs in temporary accounts against the deployed site and renders every page, filters, exports and restrictions; scans client bundles for secrets | leaves no accounts |

### Passwordless database transport

Without `DATABASE_URL`, every CLI script (`db:import`, `db:validate`, `db:check`, `db:preflight`, `db:reclassify`, `admin:grant`, `db:smoke`) uses `supabase db query --linked --project-ref <ref>` — the Management API SQL endpoint (beta), authorized by the Supabase CLI login. Notes:

- Each write batch is one `DO` block → atomic; batches are capped at ~400 KB (requests above ~1 MB are rejected by the endpoint).
- Data travels as typed JSON (`jsonb_to_recordset`) inside dollar-quoted literals whose random delimiter is verified absent from the data; scalar parameters are encoded the same way. SQL text itself is static.
- SQL containing ticket text is passed through a private temp file (never the command line) and deleted immediately.
- Transient failures (timeouts, rate limits, gateway errors) are retried; SQL errors are not.
- Concurrency: an import refuses to start while another run is marked `running` (< 2 h old).
- `DB_TRANSPORT=postgres|supabase-cli` forces a transport; `SUPABASE_CLI_TARGET=local` points the CLI transport at `supabase start` for rehearsals.

### Auth email links

- Password recovery started from the login page uses Supabase's default email template with the PKCE flow and lands on `/auth/confirm?code=…`.
- Invitations (`admin:grant --invite`, Settings → Access) land on `/auth/callback`, which removes the tokens from the address bar and exchanges them server-side (`/auth/session`, same-origin only) for the session cookie.
- Custom templates pointing at `/auth/confirm?token_hash=…&type=…` are also supported.

## 2. Manual equivalents (reference)

```bash
ENV_FILE=.env.cloud npm run db:preflight
supabase db push --dry-run && supabase db push      # schema (never `db reset --linked`)
ENV_FILE=.env.cloud npm run auth:config -- --apply
ENV_FILE=.env.cloud npm run db:import
ENV_FILE=.env.cloud npm run db:validate
ENV_FILE=.env.cloud npm run db:check
ENV_FILE=.env.cloud npm run admin:grant -- --email you@example.com --invite
ENV_FILE=.env.cloud npm run db:smoke
ENV_FILE=.env.cloud npm run web:smoke
```

## 3. GitHub repository

Repository: <https://github.com/SayedMamdouh94/ischool-cs-tickets-analytics> (branch `main`).

The `.gitignore` excludes `.env*` files (except `.env.example`) and `data/raw/*` (student data), so neither credentials nor exports can be committed. Before every push, confirm with `git status` that no `.env.local` or CSV file is staged.

> The repository is currently **public**. It contains code, migrations and documentation only (no student data or credentials), but the documentation includes aggregate operational statistics. Consider making it private (GitHub → Settings → General → Danger Zone → Change visibility); Vercel deploys private repositories normally.

## 4. Link the repository to Vercel

```bash
vercel login                     # if needed
vercel link                      # create/link the project (framework: Next.js, root: .)
```

Or in the Vercel dashboard: **Add New → Project → Import** the GitHub repository. Choose a function region close to the Supabase region (Settings → Functions).

## 5. Vercel environment variables

| Variable | Environments | Value |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Production, Preview | `https://rpofhzcqcxpuotsebzsq.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Production, Preview | Publishable key (`sb_publishable_…`) from Project Settings → API Keys |
| `NEXT_PUBLIC_SITE_URL` | Production | `https://<your-app>.vercel.app` |
| `SUPABASE_SECRET_KEY` | Production only, mark **Sensitive** | Secret key (`sb_secret_…`). Optional — only needed to send invitations from Settings → Access |

Do **not** add `DATABASE_URL` to Vercel; the web app never connects with privileged credentials.

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY production
vercel env add NEXT_PUBLIC_SITE_URL production
vercel env add SUPABASE_SECRET_KEY production --sensitive
```

## 6. Deploy

```bash
npm run verify                   # typecheck, lint, unit tests, production build
vercel --prod
```

Pushing to the default branch also deploys automatically once the repository is connected.

## 7. Verify the live dashboard

1. Open the production URL in a private window → you are redirected to `/login`.
2. `curl -i https://<your-app>.vercel.app/api/export/tickets` → `401`.
3. Confirm the database is closed to anonymous access:
   ```bash
   curl -s "https://rpofhzcqcxpuotsebzsq.supabase.co/rest/v1/tickets?select=ticket_id&limit=1" \
     -H "apikey: <publishable key>"          # → permission denied (42501)
   ```
4. Sign in as the administrator. Executive Overview shows **12,969** tickets; the header shows "Historical export · data as of …".
5. Data Quality → File-level reconciliation shows "No issue" for all four files.
6. Ticket Explorer → open a ticket → message text is visible to the admin; sign in as an analyst and confirm it is hidden.
7. `ENV_FILE=.env.cloud npm run db:check` → 0 failed (includes "no demo @local.test accounts").

## Operations

- **New exports:** see [DATA_IMPORT.md](DATA_IMPORT.md); run `db:import` then `db:validate`.
- **Schema changes:** add a new migration file (`supabase migration new <name>`), test locally with `supabase db reset` + `npm run test:integration`, then `supabase db push`.
- **Thresholds and preferences:** Settings (admin).
- **Access reviews:** Settings → Access and Audit log.
- **Backups:** Supabase daily backups (and PITR on paid plans) cover the database; the original CSV files should be archived separately in a secure location, not in Git.
