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

## 1. Configure Supabase Auth (dashboard)

Authentication → **Sign In / Providers**
- Turn **off** "Allow new users to sign up" (invite-only access).
- Keep the **Email** provider enabled. Optionally require 12+ character passwords with mixed case and digits (Authentication → Policies / Passwords).

Authentication → **URL Configuration**
- Site URL: `https://<your-app>.vercel.app` (your production domain).
- Redirect URLs: `https://<your-app>.vercel.app/**` and, for local development, `http://localhost:3000/**`.

Authentication → **Emails** → templates for *Invite user* and *Reset password*: point the link at the app's confirmation route (token-hash flow, works with server-side sessions):

```html
<!-- Invite user -->
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/account/password">Accept the invitation</a>
<!-- Reset password -->
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/account/password">Reset your password</a>
```

For production email volume, configure custom SMTP (Authentication → Emails → SMTP settings); the built-in sender is rate-limited.

## 2. Production credentials for the admin CLI

Production values live in `.env.cloud` (git-ignored, excluded from Vercel uploads, mode 600) and are used by prefixing commands with `ENV_FILE=.env.cloud`. Your local `.env.local` is never touched.

- `DATABASE_URL`: Supabase → **Connect** → **Session pooler** (port 5432) URI with the database password. Enter it yourself in the editor; never paste it into chat.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`: Project Settings → API Keys (they can also be written into the file directly from the Supabase CLI without being displayed).

## 3. Inspect, then apply the migrations

```bash
ENV_FILE=.env.cloud npm run db:preflight     # READ-ONLY: existing tables, rows, migration history
supabase link --project-ref rpofhzcqcxpuotsebzsq
supabase db push --dry-run                   # lists the migrations that would run
supabase db push
```

Proceed only if the preflight verdict is **EMPTY** or **THIS APP**. If it reports other objects, stop and review them — the migrations only create objects and insert reference data, but they would fail or interleave with an unrelated schema. Never run `supabase db reset --linked` against production.

## 4. Import and validate

```bash
ENV_FILE=.env.cloud npm run db:import -- --dry-run
ENV_FILE=.env.cloud npm run db:import
ENV_FILE=.env.cloud npm run db:validate      # expect: 62 checks passed, 0 failed
ENV_FILE=.env.cloud npm run db:check         # expect: 0 failed
```

### First administrator

Create the user in the dashboard (Authentication → Users → **Add user** → *Create new user*, "Auto confirm" checked), then:

```bash
ENV_FILE=.env.cloud npm run admin:grant -- --email you@example.com
```

or send an invitation instead (needs `SUPABASE_SECRET_KEY` and `NEXT_PUBLIC_SITE_URL` in `.env.cloud`):

```bash
ENV_FILE=.env.cloud npm run admin:grant -- --email you@example.com --invite
```

Further users can be invited from **Settings → Access**.

### Permission smoke test

```bash
ENV_FILE=.env.cloud npm run db:smoke
```

Creates temporary admin / analyst / no-role users with random in-memory passwords, verifies anonymous lockdown, disabled sign-up, rejection of the local demo credentials, analyst restrictions, admin access and the per-project counts through the public API, then deletes the temporary users. It refuses to run until a real administrator exists.

## 5. GitHub repository

Repository: <https://github.com/SayedMamdouh94/ischool-cs-tickets-analytics> (branch `main`).

The `.gitignore` excludes `.env*` files (except `.env.example`) and `data/raw/*` (student data), so neither credentials nor exports can be committed. Before every push, confirm with `git status` that no `.env.local` or CSV file is staged.

> The repository is currently **public**. It contains code, migrations and documentation only (no student data or credentials), but the documentation includes aggregate operational statistics. Consider making it private (GitHub → Settings → General → Danger Zone → Change visibility); Vercel deploys private repositories normally.

## 6. Link the repository to Vercel

```bash
vercel login                     # if needed
vercel link                      # create/link the project (framework: Next.js, root: .)
```

Or in the Vercel dashboard: **Add New → Project → Import** the GitHub repository. Choose a function region close to the Supabase region (Settings → Functions).

## 7. Configure Vercel environment variables

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

## 8. Deploy

```bash
npm run verify                   # typecheck, lint, unit tests, production build
vercel --prod
```

Pushing to the default branch also deploys automatically once the repository is connected.

## 9. Verify the live dashboard

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
