-- =============================================================================
-- CS Tickets Analytics — project lifecycle, reporting cycles, ticket identity,
-- configurable classification/status/insight settings and web import jobs.
--
-- Backward compatible with the four original projects: they move into the
-- initial reporting cycle, keep their codes, organization IDs and tickets.
--
-- Ticket identity: source Ticket_IDs are unique within a project (the original
-- exports never repeat one), but an "Archive & start new" cycle may legitimately
-- re-import the same IDs into a fresh project. Tickets therefore get an internal
-- surrogate key (tickets.id) and the source ID becomes unique per project.
-- Child tables reference the internal key (ticket_pk).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Reporting cycles
-- -----------------------------------------------------------------------------
create table public.reporting_cycles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  description text check (description is null or length(description) <= 1000),
  -- draft: being prepared by an "archive & start new" import; never shown in analytics.
  status text not null default 'active' check (status in ('draft', 'active', 'archived')),
  -- The cycle the dashboard shows by default. Exactly one at most.
  is_current boolean not null default false,
  display_order smallint not null default 0,
  archived_at timestamptz,
  archived_by uuid references auth.users (id) on delete set null,
  archive_reason text check (archive_reason is null or length(archive_reason) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reporting_cycles_current_is_active check (not is_current or status = 'active'),
  constraint reporting_cycles_archived_meta check ((status = 'archived') = (archived_at is not null))
);

comment on table public.reporting_cycles is
  'A reporting cycle groups the projects analysed together. Analytics never combine cycles; archived cycles stay available as history.';

create unique index reporting_cycles_one_current on public.reporting_cycles ((true)) where is_current;

create trigger reporting_cycles_touch_updated_at
before update on public.reporting_cycles
for each row execute function private.touch_updated_at();

insert into public.reporting_cycles (code, name, description, status, is_current, display_order)
values ('CYCLE_2026', '2026 reporting cycle',
        'Initial cycle: DECI 4th & Summer intakes and DEMI 3rd & Summer intakes.', 'active', true, 1);

-- -----------------------------------------------------------------------------
-- Project lifecycle
-- -----------------------------------------------------------------------------
alter table public.projects
  add column cycle_id uuid references public.reporting_cycles (id) on delete restrict,
  add column status text not null default 'active' check (status in ('draft', 'active', 'archived')),
  add column description text check (description is null or length(description) <= 1000),
  add column archived_at timestamptz,
  add column archived_by uuid references auth.users (id) on delete set null,
  add column archive_reason text check (archive_reason is null or length(archive_reason) <= 500),
  -- 'project' when archived on its own, 'cycle' when archived with its whole cycle (restored together).
  add column archived_via text check (archived_via in ('project', 'cycle')),
  add column created_by uuid references auth.users (id) on delete set null;

update public.projects
   set cycle_id = (select id from public.reporting_cycles where code = 'CYCLE_2026'),
       status = case when is_active then 'active' else 'archived' end,
       archived_at = case when is_active then null else now() end,
       archived_via = case when is_active then null else 'project' end;

alter table public.projects alter column cycle_id set not null;
alter table public.projects drop column is_active;
alter table public.projects add constraint projects_archived_meta check ((status = 'archived') = (archived_at is not null));

-- New programs and intakes may use any intake grouping (not only Regular/Summer).
alter table public.projects drop constraint projects_intake_group_check;
alter table public.projects add constraint projects_intake_group_check check (length(btrim(intake_group)) between 1 and 40);

-- An Organization_ID maps exports to exactly one ACTIVE project. Archived (and
-- draft) projects may share it, so a fresh dataset can replace an archived one.
alter table public.projects drop constraint projects_organization_id_key;
create unique index projects_active_organization_key on public.projects (organization_id) where status = 'active';
create index projects_cycle_idx on public.projects (cycle_id, status);

comment on column public.projects.status is
  'draft: being populated by an archive-and-start-new import (hidden everywhere); active: analysed by default; archived: read-only history.';

-- -----------------------------------------------------------------------------
-- Ticket identity: internal surrogate key, source ID unique per project
-- -----------------------------------------------------------------------------
alter table public.tickets add column id bigint;

-- Deterministic numbering in source-ID order. Triggers are disabled so that
-- updated_at keeps the time of the last import, not the time of this migration.
alter table public.tickets disable trigger user;
update public.tickets t
   set id = s.rn
  from (select ticket_id, row_number() over (order by ticket_id) as rn from public.tickets) s
 where s.ticket_id = t.ticket_id;
alter table public.tickets enable trigger user;

alter table public.tickets alter column id set not null;
alter table public.tickets alter column id add generated always as identity;
select setval(pg_get_serial_sequence('public.tickets', 'id'), greatest((select max(id) from public.tickets), 1),
              (select count(*) > 0 from public.tickets));

-- Child tables: reference the internal key.
alter table public.ticket_attachments add column ticket_pk bigint;
update public.ticket_attachments a set ticket_pk = t.id from public.tickets t where t.ticket_id = a.ticket_id;
alter table public.ticket_classifications add column ticket_pk bigint;
update public.ticket_classifications c set ticket_pk = t.id from public.tickets t where t.ticket_id = c.ticket_id;

do $$
begin
  if exists (select 1 from public.ticket_attachments where ticket_pk is null)
     or exists (select 1 from public.ticket_classifications where ticket_pk is null) then
    raise exception 'Ticket key migration failed: unmatched child rows';
  end if;
end;
$$;

alter table public.ticket_attachments drop constraint ticket_attachments_ticket_id_fkey;
alter table public.ticket_classifications drop constraint ticket_classifications_ticket_id_fkey;
alter table public.ticket_attachments drop constraint ticket_attachments_ticket_id_attachment_type_position_key;
alter table public.ticket_classifications drop constraint ticket_classifications_ticket_id_method_version_key;
drop index public.ticket_classifications_current_idx;

alter table public.tickets drop constraint tickets_pkey;
alter table public.tickets add constraint tickets_pkey primary key (id);
alter table public.tickets add constraint tickets_project_ticket_key unique (project_id, ticket_id);
create index tickets_ticket_id_idx on public.tickets (ticket_id);

alter table public.ticket_attachments alter column ticket_pk set not null;
alter table public.ticket_attachments
  add constraint ticket_attachments_ticket_pk_fkey foreign key (ticket_pk) references public.tickets (id) on delete cascade,
  add constraint ticket_attachments_ticket_pk_type_position_key unique (ticket_pk, attachment_type, position);
alter table public.ticket_attachments drop column ticket_id;

alter table public.ticket_classifications alter column ticket_pk set not null;
alter table public.ticket_classifications
  add constraint ticket_classifications_ticket_pk_fkey foreign key (ticket_pk) references public.tickets (id) on delete cascade,
  add constraint ticket_classifications_ticket_pk_method_version_key unique (ticket_pk, method, version);
alter table public.ticket_classifications drop column ticket_id;
create unique index ticket_classifications_current_idx on public.ticket_classifications (ticket_pk) where is_current;

comment on column public.tickets.id is 'Internal key. Source Ticket_IDs (ticket_id) are unique per project only.';

-- Tickets never move between projects (unchanged rule, clearer message).
create or replace function private.tickets_guard_project()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.project_id is distinct from old.project_id
     or new.organization_id is distinct from old.organization_id
     or new.ticket_id is distinct from old.ticket_id then
    raise exception 'TICKET_ID_COLLISION: ticket % belongs to project %, refusing to reassign it',
      old.ticket_id, old.project_id
      using errcode = '23505',
            hint = 'Tickets never move between projects. Investigate the source exports.';
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Topic → analytical category mapping (one row per source Topic)
-- -----------------------------------------------------------------------------
create table public.topic_categories (
  topic text primary key check (length(btrim(topic)) between 1 and 500),
  category_id smallint not null references public.ticket_categories (id) on delete restrict,
  source text not null default 'admin' check (source in ('seed', 'admin')),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.topic_categories is
  'Maps each source Topic to an analytical category. Topics without a row are classified as "uncategorized" until an administrator maps them.';

insert into public.topic_categories (topic, category_id, source)
select distinct on (t.topic) t.topic, c.id, 'seed'
  from public.ticket_categories c
  cross join lateral unnest(c.source_topics) as t(topic)
 where c.kind = 'category'
 order by t.topic, c.sort_order;

alter table public.ticket_categories drop column source_topics;

create or replace function private.topic_categories_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.ticket_categories k where k.id = new.category_id and k.kind = 'category') then
    raise exception 'Topics can only be mapped to a category (not an issue theme)' using errcode = '22023';
  end if;
  new.topic := btrim(new.topic);
  new.updated_at := now();
  return new;
end;
$$;

create trigger topic_categories_guard
before insert or update on public.topic_categories
for each row execute function private.topic_categories_guard();

-- Category for a topic, falling back to "uncategorized".
create or replace function private.category_id_for_topic(p_topic text)
returns smallint
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select m.category_id from public.topic_categories m where m.topic = btrim(p_topic)),
    (select k.id from public.ticket_categories k where k.code = 'uncategorized')
  );
$$;

-- -----------------------------------------------------------------------------
-- Status classes: which source Status values count as open (backlog) or closed.
-- '__none__' stands for a missing status. Values without a row are reported as
-- "unclassified" and treated as open until an administrator classifies them.
-- -----------------------------------------------------------------------------
create table public.ticket_statuses (
  status text primary key check (status = '__none__' or status ~ '^[A-Za-z][A-Za-z _-]{0,39}$'),
  status_class text not null check (status_class in ('open', 'closed')),
  label text not null check (length(btrim(label)) between 1 and 60),
  sort_order smallint not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.ticket_statuses is
  'Classifies source Status values as open or closed for backlog metrics. Unlisted values count as open and are flagged.';

insert into public.ticket_statuses (status, status_class, label, sort_order)
values
  ('pending', 'open', 'Pending', 1),
  ('completed', 'closed', 'Completed', 2),
  ('rejected', 'closed', 'Rejected', 3),
  ('__none__', 'open', 'Missing status', 9);

create trigger ticket_statuses_touch_updated_at
before update on public.ticket_statuses
for each row execute function private.touch_updated_at();

-- 'open' / 'closed' / 'unclassified' for a raw status value.
create or replace function private.status_class(p_status text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select s.status_class from public.ticket_statuses s where s.status = coalesce(p_status, '__none__')),
    'unclassified'
  );
$$;

-- -----------------------------------------------------------------------------
-- Insight rule settings (previously hardcoded thresholds)
-- -----------------------------------------------------------------------------
create table public.insight_rules (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,59}$'),
  value numeric not null,
  min_value numeric not null,
  max_value numeric not null,
  unit text not null check (unit in ('count', 'ratio', 'factor', 'days', 'score')),
  label text not null,
  description text not null,
  sort_order smallint not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  constraint insight_rules_value_range check (value between min_value and max_value)
);

comment on table public.insight_rules is
  'Settings for the deterministic Insights & Recommendations rules. Editable by administrators.';

create trigger insight_rules_touch_updated_at
before update on public.insight_rules
for each row execute function private.touch_updated_at();

insert into public.insight_rules (key, value, min_value, max_value, unit, label, description, sort_order)
values
  ('trend_window_days', 30, 7, 120, 'days', 'Trend comparison window',
   'Length of the latest period compared with the preceding period of equal length, measured per project from that project''s own latest export date.', 1),
  ('trend_min_current', 20, 1, 10000, 'count', 'Minimum tickets for a topic trend',
   'A topic trend is only reported when the topic has at least this many tickets in the latest period.', 2),
  ('trend_min_change', 0.5, 0.05, 10, 'ratio', 'Minimum change in topic share',
   'Relative change in the topic''s share of all tickets (not raw counts) needed to call it rising or falling.', 3),
  ('trend_min_z', 1.96, 0, 10, 'score', 'Statistical confidence for trends (z)',
   'Two-proportion z-score the share change must reach (1.96 ≈ 95% confidence) so random variation is not reported as a trend.', 4),
  ('slow_topic_min_n', 30, 5, 10000, 'count', 'Minimum resolved tickets for slow topics',
   'A topic''s resolution time is compared only when at least this many of its tickets were resolved.', 10),
  ('slow_topic_factor', 1.25, 1, 10, 'factor', 'Slow topic factor',
   'A topic is flagged when its median resolution time exceeds the overall median by this factor.', 11),
  ('dominant_theme_share', 0.4, 0.1, 1, 'ratio', 'Dominant theme share',
   'An issue theme dominates a topic when it covers at least this share of the topic''s tickets.', 20),
  ('dominant_theme_min_topic', 100, 10, 100000, 'count', 'Minimum topic size for themes',
   'Topics with fewer tickets are not analysed for dominant themes.', 21),
  ('lesson_min_students', 50, 2, 100000, 'count', 'Lesson hotspot: minimum students',
   'A lesson is reported when at least this many different students raised tickets about it.', 22),
  ('recurring_min_students', 2, 2, 1000, 'count', 'Recurring session: minimum students',
   'A session is recurring when at least this many different students reported it.', 23),
  ('spike_window_days', 28, 7, 90, 'days', 'Spike baseline window',
   'Trailing days used for each project''s robust baseline (median and MAD).', 30),
  ('spike_threshold', 3.5, 1, 20, 'score', 'Spike threshold (robust z)',
   'A day is unusual when its volume exceeds the project''s trailing median by this robust z-score.', 31),
  ('spike_min_count', 10, 1, 10000, 'count', 'Spike minimum tickets',
   'Days with fewer tickets are never reported as spikes.', 32),
  ('spike_rampup_days', 21, 0, 120, 'days', 'Intake ramp-up period',
   'Days after a project''s first ticket that are excluded from spike detection, so an intake launch is not mistaken for an incident.', 33),
  ('breach_watch_rate', 0.2, 0, 1, 'ratio', 'Resolution breach rate: watch',
   'Share of resolved tickets over the resolution threshold that is marked "watch".', 40),
  ('breach_attention_rate', 0.5, 0, 1, 'ratio', 'Resolution breach rate: attention',
   'Share of resolved tickets over the resolution threshold that is marked "needs attention".', 41),
  ('stale_export_days', 7, 1, 365, 'days', 'Outdated export warning',
   'A project''s export is flagged as outdated when it ends this many days before the most recent export in the same view.', 50),
  ('generic_ack_caveat_share', 0.5, 0, 1, 'ratio', 'Templated response caveat',
   'Show the "recorded response is not proof of a human reply" caveat when templated acknowledgements exceed this share.', 51);

-- -----------------------------------------------------------------------------
-- Field-level change history for tickets updated by later exports
-- -----------------------------------------------------------------------------
create table public.ticket_changes (
  id bigint generated always as identity primary key,
  ticket_pk bigint not null references public.tickets (id) on delete cascade,
  import_run_id uuid references public.import_runs (id) on delete set null,
  changed_at timestamptz not null default now(),
  previous_row_hash text not null,
  new_row_hash text not null,
  previous_source_data_as_of timestamptz,
  new_source_data_as_of timestamptz,
  -- {"Status": {"old": "pending", "new": "completed"}, ...}. May contain student text: admin-only.
  changes jsonb not null
);

comment on table public.ticket_changes is
  'Previous values of source fields whenever an import updates a ticket. Admin-only (may contain message text).';

create index ticket_changes_ticket_idx on public.ticket_changes (ticket_pk, changed_at desc);
create index ticket_changes_run_idx on public.ticket_changes (import_run_id);

create or replace function private.tickets_record_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_field record;
begin
  if new.row_hash is not distinct from old.row_hash then
    return new;
  end if;
  for v_field in
    select * from (values
      ('Topic', 'topic'), ('Message', 'message'), ('Status', 'status'), ('Priority', 'priority'),
      ('Department', 'department'), ('Owner_Type', 'owner_type'), ('Owner_ID', 'owner_id'),
      ('Affected_Student_ID', 'affected_student_id'), ('Created_At', 'created_at'),
      ('Responded_At', 'responded_at'), ('Resolved_At', 'resolved_at'), ('Response', 'response'),
      ('Note', 'note'), ('Responder_Name', 'responder_name'), ('Resolved_By', 'resolved_by'),
      ('Attachment_URLs', 'attachment_urls'), ('Response_Attachment_URLs', 'response_attachment_urls')
    ) as f(label, col)
  loop
    if (v_old -> v_field.col) is distinct from (v_new -> v_field.col) then
      v_changes := v_changes || jsonb_build_object(v_field.label,
        jsonb_build_object('old', v_old -> v_field.col, 'new', v_new -> v_field.col));
    end if;
  end loop;
  insert into public.ticket_changes (ticket_pk, import_run_id, previous_row_hash, new_row_hash,
                                     previous_source_data_as_of, new_source_data_as_of, changes)
  values (new.id, new.last_import_run_id, old.row_hash, new.row_hash,
          old.source_data_as_of, new.source_data_as_of, v_changes);
  return new;
end;
$$;

create trigger tickets_record_changes
after update on public.tickets
for each row execute function private.tickets_record_changes();

-- -----------------------------------------------------------------------------
-- Web import jobs
-- -----------------------------------------------------------------------------
alter table public.import_runs
  add column source text not null default 'cli' check (source in ('cli', 'web')),
  add column triggered_by uuid references auth.users (id) on delete set null,
  add column invalid_row_policy text check (invalid_row_policy in ('all_or_nothing', 'import_valid_rows'));

create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('upsert', 'archive_and_start')),
  status text not null default 'awaiting_upload' check (status in (
    'awaiting_upload', 'uploaded', 'validating', 'ready', 'importing',
    'completed', 'completed_with_errors', 'failed', 'cancelled')),

  -- Target project. upsert: an existing active project. archive_and_start: the
  -- draft project created when the import is confirmed.
  project_id uuid references public.projects (id) on delete restrict,
  -- archive_and_start only
  archive_scope text check (archive_scope in ('project', 'cycle')),
  archive_project_id uuid references public.projects (id) on delete restrict,
  archive_cycle_id uuid references public.reporting_cycles (id) on delete restrict,
  new_project jsonb,
  new_cycle jsonb,
  new_cycle_id uuid references public.reporting_cycles (id) on delete restrict,

  -- Uploaded file (private Storage bucket "imports")
  storage_path text not null unique,
  original_filename text not null check (length(original_filename) between 1 and 255),
  file_format text not null check (file_format in ('csv', 'xlsx')),
  declared_size_bytes bigint not null check (declared_size_bytes > 0),
  file_size_bytes bigint check (file_size_bytes >= 0),
  file_hash text check (file_hash ~ '^[0-9a-f]{64}$'),
  uploaded_at timestamptz,

  -- Validation
  rows_total integer check (rows_total >= 0),
  rows_staged integer not null default 0 check (rows_staged >= 0),
  rows_valid integer,
  rows_invalid integer,
  warnings_count integer,
  data_as_of timestamptz,
  min_created_at timestamptz,
  max_created_at timestamptz,
  validation_summary jsonb not null default '{}'::jsonb,
  preview jsonb,
  preview_version integer not null default 0,
  preview_computed_at timestamptz,

  -- Execution
  invalid_row_policy text check (invalid_row_policy in ('all_or_nothing', 'import_valid_rows')),
  import_run_id uuid references public.import_runs (id) on delete restrict,
  rows_applied integer not null default 0 check (rows_applied >= 0),
  rows_to_apply integer,
  progress_phase text,
  progress_done integer not null default 0,
  progress_total integer not null default 0,
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  last_kick_at timestamptz,
  error_code text,
  last_error text,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz,
  completed_at timestamptz,
  cancelled_by uuid references auth.users (id) on delete set null,
  cancelled_at timestamptz,

  constraint import_jobs_mode_fields check (
    (mode = 'upsert' and project_id is not null and archive_scope is null)
    or (mode = 'archive_and_start' and archive_scope is not null and new_project is not null
        and ((archive_scope = 'project' and archive_project_id is not null)
          or (archive_scope = 'cycle' and archive_cycle_id is not null and new_cycle is not null)))
  )
);

comment on table public.import_jobs is
  'Web import jobs: upload → validation → confirmation → batched import. Durable state with leases so no import is lost.';

-- One import at a time per project, and nothing else may write it meanwhile.
create unique index import_jobs_one_importing_per_project on public.import_jobs (project_id) where status = 'importing';
create index import_jobs_status_idx on public.import_jobs (status, lease_expires_at);
create index import_jobs_created_idx on public.import_jobs (created_at desc);

create trigger import_jobs_touch_updated_at
before update on public.import_jobs
for each row execute function private.touch_updated_at();

-- Staged rows (parsed and validated by the worker; applied in batches).
create table public.import_job_rows (
  job_id uuid not null references public.import_jobs (id) on delete cascade,
  row_number integer not null check (row_number >= 1),
  line integer,
  ticket_id bigint,
  organization_id integer,
  row_hash text,
  is_valid boolean not null,
  -- Normalized ticket columns (TicketRecord JSON) for valid rows.
  record jsonb,
  attachments jsonb not null default '[]'::jsonb,
  -- Rule-based issue theme computed by the worker (category comes from the topic mapping).
  theme jsonb,
  -- Raw source values, kept for rejected rows (written to import_errors).
  raw jsonb,
  error_code text,
  error_message text,
  planned_action text check (planned_action in ('insert', 'update', 'unchanged', 'stale', 'rejected')),
  applied_action text check (applied_action in ('insert', 'update', 'unchanged', 'stale', 'rejected')),
  applied_at timestamptz,
  primary key (job_id, row_number)
);

comment on table public.import_job_rows is 'Staging area for web imports. Contains student text: no client access at all.';

create index import_job_rows_ticket_idx on public.import_job_rows (job_id, ticket_id);
create index import_job_rows_pending_idx on public.import_job_rows (job_id, row_number) where is_valid and applied_at is null;

-- Validation findings shown before confirmation and downloadable as a report.
create table public.import_job_issues (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.import_jobs (id) on delete cascade,
  severity text not null check (severity in ('error', 'warning', 'info')),
  code text not null check (code ~ '^[A-Z][A-Z0-9_]+$'),
  row_number integer,
  line integer,
  ticket_id bigint,
  column_name text,
  message text not null,
  value_excerpt text check (value_excerpt is null or length(value_excerpt) <= 120)
);

create index import_job_issues_job_idx on public.import_job_issues (job_id, severity, row_number);
create unique index import_job_issues_row_key on public.import_job_issues (job_id, row_number, code, coalesce(column_name, ''))
  where row_number is not null;

-- Lifecycle events (audit trail of each job).
create table public.import_job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.import_jobs (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor uuid references auth.users (id) on delete set null,
  event text not null check (event ~ '^[a-z][a-z0-9_.]+$'),
  details jsonb not null default '{}'::jsonb
);

create index import_job_events_job_idx on public.import_job_events (job_id, occurred_at);

-- -----------------------------------------------------------------------------
-- Private Storage bucket for uploaded exports. No storage policies are created:
-- browsers upload only through short-lived signed URLs issued after the server
-- verified the administrator, and only the server-side worker reads files.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imports', 'imports', false, 52428800, array[
  'text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- -----------------------------------------------------------------------------
-- Access control for the new tables
-- -----------------------------------------------------------------------------
alter table public.reporting_cycles enable row level security;
alter table public.topic_categories enable row level security;
alter table public.ticket_statuses enable row level security;
alter table public.insight_rules enable row level security;
alter table public.ticket_changes enable row level security;
alter table public.import_jobs enable row level security;
alter table public.import_job_rows enable row level security;
alter table public.import_job_issues enable row level security;
alter table public.import_job_events enable row level security;

revoke all on public.reporting_cycles, public.topic_categories, public.ticket_statuses, public.insight_rules,
  public.ticket_changes, public.import_jobs, public.import_job_rows, public.import_job_issues,
  public.import_job_events from anon, authenticated;

grant select on public.reporting_cycles to authenticated;
create policy reporting_cycles_select on public.reporting_cycles
  for select to authenticated using ((select private.has_app_access()) and status <> 'draft');

grant select on public.topic_categories to authenticated;
create policy topic_categories_select on public.topic_categories
  for select to authenticated using ((select private.has_app_access()));

grant select on public.ticket_statuses to authenticated;
create policy ticket_statuses_select on public.ticket_statuses
  for select to authenticated using ((select private.has_app_access()));

grant select on public.insight_rules to authenticated;
create policy insight_rules_select on public.insight_rules
  for select to authenticated using ((select private.has_app_access()));

grant select on public.ticket_changes to authenticated;
create policy ticket_changes_select on public.ticket_changes
  for select to authenticated using ((select private.is_admin()));

grant select on public.import_jobs to authenticated;
create policy import_jobs_select on public.import_jobs
  for select to authenticated using ((select private.is_admin()));

grant select on public.import_job_issues to authenticated;
create policy import_job_issues_select on public.import_job_issues
  for select to authenticated using ((select private.is_admin()));

grant select on public.import_job_events to authenticated;
create policy import_job_events_select on public.import_job_events
  for select to authenticated using ((select private.is_admin()));

-- import_job_rows: no grants and no policies — only the server-side worker
-- (service role) and SECURITY DEFINER functions touch staged rows.

-- Projects are no longer editable column-by-column; all changes go through
-- audited functions.
revoke update on public.projects from authenticated;
drop policy if exists projects_update on public.projects;
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated using ((select private.has_app_access()) and status <> 'draft');

-- Categories: name/description edits go through functions as well.
revoke update on public.ticket_categories from authenticated;
drop policy if exists ticket_categories_update on public.ticket_categories;

-- Tickets: expose the internal key alongside the existing metadata columns.
grant select (id) on public.tickets to authenticated;

-- Tickets of draft projects (an archive-and-start-new import in progress) are not readable directly.
drop policy if exists tickets_select on public.tickets;
create policy tickets_select on public.tickets
  for select to authenticated using (
    (select private.has_app_access())
    and exists (select 1 from public.projects p where p.id = project_id and p.status <> 'draft'));
