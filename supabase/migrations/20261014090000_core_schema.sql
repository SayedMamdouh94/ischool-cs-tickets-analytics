-- =============================================================================
-- CS Tickets Analytics — core schema
--
-- One centralized database for all educational projects. Project identity is
-- explicit (projects table + foreign keys), source data is preserved verbatim,
-- and every import is traceable (import_runs / import_errors).
-- =============================================================================

create extension if not exists pg_trgm with schema extensions;

-- Internal helpers live in a schema that is NOT exposed through the Data API.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Generic helpers
-- -----------------------------------------------------------------------------
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Classifies the recorded `Response` text. The exports show that almost all
-- responses are templated acknowledgements, so a recorded response timestamp
-- must not be treated as proof of a human reply.
create or replace function private.classify_response(p_response text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_response is null or btrim(p_response) = '' then 'missing'
    when btrim(p_response) like 'تم استلام طلبكم بنجاح%'
      or btrim(p_response) ilike 'We have received your request%' then 'generic_acknowledgement'
    when btrim(p_response) like 'تم معالجة طلبك تلقائي%'
      or btrim(p_response) ilike 'Your request has been processed automatically%' then 'automated'
    else 'custom'
  end;
$$;

-- -----------------------------------------------------------------------------
-- projects
-- -----------------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  program text not null check (program ~ '^[A-Z][A-Z0-9]{1,19}$'),
  intake text not null check (length(btrim(intake)) between 1 and 60),
  intake_group text not null check (intake_group in ('Regular', 'Summer')),
  organization_id integer not null unique check (organization_id > 0),
  -- Case-insensitive fragment expected in export filenames for this project.
  file_name_hint text not null check (length(btrim(file_name_hint)) > 0),
  display_order smallint not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Allows tickets to reference (project, organization) as a pair so the
  -- organization recorded on a ticket can never disagree with its project.
  unique (id, organization_id)
);

comment on table public.projects is 'Educational projects (program + intake) whose support tickets are analysed.';

create trigger projects_touch_updated_at
before update on public.projects
for each row execute function private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- import_runs / import_errors
-- -----------------------------------------------------------------------------
create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  source_filename text not null,
  project_id uuid references public.projects (id) on delete restrict,
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  file_size_bytes bigint check (file_size_bytes >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'completed', 'completed_with_errors', 'failed')),
  records_in_file integer check (records_in_file >= 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  skipped_unchanged_count integer not null default 0 check (skipped_unchanged_count >= 0),
  skipped_stale_count integer not null default 0 check (skipped_stale_count >= 0),
  skipped_count integer generated always as (skipped_unchanged_count + skipped_stale_count) stored,
  rejected_count integer not null default 0 check (rejected_count >= 0),
  -- Latest timestamp found anywhere in the file: a proxy for when it was exported.
  data_as_of timestamptz,
  min_created_at timestamptz,
  max_created_at timestamptz,
  duplicate_of_run_id uuid references public.import_runs (id) on delete set null,
  update_policy text not null,
  importer_version text not null,
  error_summary text,
  -- File-level reconciliation computed from the CSV itself (status counts,
  -- missing values, anomalies). Never contains message text.
  reconciliation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint import_runs_counts_reconcile check (
    status in ('running', 'failed')
    or records_in_file = inserted_count + updated_count + skipped_unchanged_count
      + skipped_stale_count + rejected_count
  )
);

comment on table public.import_runs is 'One row per CSV file import attempt, with counts and file-level reconciliation.';

create index import_runs_project_started_idx on public.import_runs (project_id, started_at desc);
create index import_runs_file_hash_idx on public.import_runs (file_hash);

create table public.import_errors (
  id bigint generated always as identity primary key,
  import_run_id uuid not null references public.import_runs (id) on delete cascade,
  source_row_number integer check (source_row_number >= 1),
  ticket_id bigint,
  error_code text not null check (error_code ~ '^[A-Z][A-Z0-9_]+$'),
  validation_error text not null,
  raw_row jsonb,
  recorded_at timestamptz not null default now()
);

comment on table public.import_errors is 'Rejected or invalid source rows. raw_row may contain student text: admin-only.';

create index import_errors_run_idx on public.import_errors (import_run_id);
create index import_errors_code_idx on public.import_errors (error_code);

-- -----------------------------------------------------------------------------
-- tickets
-- -----------------------------------------------------------------------------
create table public.tickets (
  -- Source identifiers are currently globally unique across all exports.
  ticket_id bigint primary key check (ticket_id > 0),
  project_id uuid not null,
  organization_id integer not null,

  -- Original source fields (preserved verbatim; blanks become NULL).
  topic text not null,
  message text,
  status text,
  priority text,
  department text,
  owner_type text,
  owner_id text,
  affected_student_id text,
  created_at timestamptz not null,
  responded_at timestamptz,
  resolved_at timestamptz,
  response text,
  note text,
  responder_name text,
  resolved_by text,
  attachment_urls text,
  response_attachment_urls text,

  -- Structured fields parsed from the message prefix (see docs/DATA_IMPORT.md).
  sub_topic text,
  session_ref text,
  lesson_name text,
  message_language text check (message_language in ('ar', 'en', 'mixed', 'none')),
  parser_version text,

  -- Derived, maintained by trigger from `response`.
  response_kind text not null default 'missing'
    check (response_kind in ('missing', 'generic_acknowledgement', 'automated', 'custom')),

  -- Durations in seconds (NULL when either timestamp is missing).
  response_seconds bigint generated always as
    (extract(epoch from (responded_at - created_at))::bigint) stored,
  resolution_seconds bigint generated always as
    (extract(epoch from (resolved_at - created_at))::bigint) stored,

  -- Calendar attributes in the Africa/Cairo timezone (absolute instants stay in TIMESTAMPTZ).
  created_date date generated always as
    ((created_at at time zone 'Africa/Cairo')::date) stored,
  created_hour smallint generated always as
    (extract(hour from (created_at at time zone 'Africa/Cairo'))::smallint) stored,
  created_isodow smallint generated always as
    (extract(isodow from (created_at at time zone 'Africa/Cairo'))::smallint) stored,

  -- Import lineage.
  source_filename text not null,
  source_row_number integer not null check (source_row_number >= 1),
  source_data_as_of timestamptz not null,
  row_hash text not null check (row_hash ~ '^[0-9a-f]{64}$'),
  first_import_run_id uuid not null references public.import_runs (id) on delete restrict,
  last_import_run_id uuid not null references public.import_runs (id) on delete restrict,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tickets_project_org_fk foreign key (project_id, organization_id)
    references public.projects (id, organization_id) on update cascade on delete restrict
);

comment on table public.tickets is 'Historical support tickets imported from CSV exports. Not a live ticketing system.';
comment on column public.tickets.response_seconds is 'Recorded first response duration (responded_at - created_at). Not proof of a human reply.';
comment on column public.tickets.created_date is 'Calendar date of created_at in Africa/Cairo.';
comment on column public.tickets.source_data_as_of is 'data_as_of of the export that last wrote this row; used by the update policy.';

create index tickets_project_created_idx on public.tickets (project_id, created_date);
create index tickets_created_date_idx on public.tickets (created_date);
create index tickets_status_idx on public.tickets (status);
create index tickets_topic_idx on public.tickets (topic);
create index tickets_responder_idx on public.tickets (responder_name);
create index tickets_resolver_idx on public.tickets (resolved_by);
create index tickets_owner_idx on public.tickets (owner_id);
create index tickets_session_ref_idx on public.tickets (session_ref) where session_ref is not null;
create index tickets_unresolved_idx on public.tickets (project_id, created_at) where resolved_at is null;
create index tickets_resolved_at_idx on public.tickets (resolved_at);
create index tickets_message_trgm_idx on public.tickets using gin (message extensions.gin_trgm_ops);

create or replace function private.tickets_derive_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.response_kind := private.classify_response(new.response);
  return new;
end;
$$;

create trigger tickets_derive_fields
before insert or update of response on public.tickets
for each row execute function private.tickets_derive_fields();

-- Ticket IDs are globally unique today. If a future export reuses an ID in a
-- different project, refuse to silently move/overwrite the other project's row.
create or replace function private.tickets_guard_project()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.project_id is distinct from old.project_id
     or new.organization_id is distinct from old.organization_id then
    raise exception 'TICKET_ID_COLLISION: ticket % belongs to project %, refusing to reassign it to project %',
      old.ticket_id, old.project_id, new.project_id
      using errcode = '23505',
            hint = 'Ticket IDs must be unique across projects. Investigate the source exports.';
  end if;
  return new;
end;
$$;

create trigger tickets_guard_project
before update on public.tickets
for each row execute function private.tickets_guard_project();

create trigger tickets_touch_updated_at
before update on public.tickets
for each row execute function private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- ticket_attachments
-- -----------------------------------------------------------------------------
create table public.ticket_attachments (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.tickets (ticket_id) on delete cascade,
  attachment_type text not null check (attachment_type in ('request', 'response')),
  position smallint not null check (position >= 1),
  url text not null,
  url_host text,
  file_name text,
  file_extension text,
  created_at timestamptz not null default now(),
  unique (ticket_id, attachment_type, position)
);

comment on table public.ticket_attachments is 'Normalized attachment references. URLs are stored, never fetched.';

-- -----------------------------------------------------------------------------
-- ticket_categories / ticket_classifications
-- -----------------------------------------------------------------------------
create table public.ticket_categories (
  id smallint generated always as identity primary key,
  code text not null unique check (code ~ '^[a-z][a-z0-9_]{1,59}$'),
  kind text not null check (kind in ('category', 'subcategory')),
  parent_id smallint references public.ticket_categories (id) on delete restrict,
  name_en text not null,
  name_ar text,
  description text,
  -- For categories: the source `Topic` values mapped to this category.
  source_topics text[] not null default '{}',
  sort_order smallint not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ticket_categories is
  'Analytical categories (grouping of source topics) and subcategories (issue themes detected from message text).';

create trigger ticket_categories_touch_updated_at
before update on public.ticket_categories
for each row execute function private.touch_updated_at();

create table public.ticket_classifications (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.tickets (ticket_id) on delete cascade,
  category_id smallint not null references public.ticket_categories (id) on delete restrict,
  subcategory_id smallint references public.ticket_categories (id) on delete restrict,
  method text not null check (method in ('rule_based', 'manual', 'ai_assisted')),
  confidence numeric(4, 3) check (confidence between 0 and 1),
  version text not null,
  -- Evidence such as matched keywords. Must not contain message text.
  evidence jsonb not null default '{}'::jsonb,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  unique (ticket_id, method, version)
);

comment on table public.ticket_classifications is
  'Derived, versioned analytical classification. Separate from the original Topic, which is preserved on tickets.';

create unique index ticket_classifications_current_idx
  on public.ticket_classifications (ticket_id) where is_current;
create index ticket_classifications_category_idx on public.ticket_classifications (category_id) where is_current;
create index ticket_classifications_subcategory_idx on public.ticket_classifications (subcategory_id) where is_current;

-- -----------------------------------------------------------------------------
-- Settings
-- -----------------------------------------------------------------------------
create table public.analytics_thresholds (
  key text primary key check (key in ('response_hours', 'resolution_hours')),
  value_hours numeric(8, 2) not null check (value_hours > 0 and value_hours <= 8760),
  label text not null,
  description text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.analytics_thresholds is
  'Illustrative monitoring thresholds. NOT contractual SLAs.';

create trigger analytics_thresholds_touch_updated_at
before update on public.analytics_thresholds
for each row execute function private.touch_updated_at();

create table public.app_settings (
  key text primary key check (key in ('date_preset_anchor', 'default_date_preset', 'organization_name')),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

create trigger app_settings_touch_updated_at
before update on public.app_settings
for each row execute function private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Access control and audit
-- -----------------------------------------------------------------------------
create table public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'analyst')),
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_roles is
  'Application roles. Users without a row here have no access to any data, even if authenticated.';

create trigger user_roles_touch_updated_at
before update on public.user_roles
for each row execute function private.touch_updated_at();

create table public.audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  user_id uuid references auth.users (id) on delete set null,
  action text not null check (action ~ '^[a-z][a-z0-9_.]+$'),
  -- Filters, counts and identifiers only. Never message content.
  details jsonb not null default '{}'::jsonb
);

create index audit_events_occurred_idx on public.audit_events (occurred_at desc);
create index audit_events_user_idx on public.audit_events (user_id, occurred_at desc);
