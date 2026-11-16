-- =============================================================================
-- CS Tickets Analytics — custom roles, feature permissions and project access
--
-- Model (replaces the fixed admin/analyst pair):
--   * public.app_roles: named roles, each a set of permission keys from
--     private.permission_catalog(). 'admin' is a locked system role that always
--     holds every permission; 'analyst' is seeded with exactly the rights the
--     analyst role had before (every page + aggregated CSV exports) and can be
--     edited but not deleted. Administrators create further roles in the app.
--   * public.user_roles.role now references app_roles(code). Each account also
--     has a project scope: all_projects, or only the programs
--     (public.user_program_access — includes that program's future projects)
--     and individual projects (public.user_project_access) granted to it.
--   * Managing users and roles stays with the 'admin' role
--     (private.require_role('admin')), so nobody can grant themselves more.
--   * 'projects.manage' and 'imports.manage' change data across projects and
--     cycles, so they only take effect for accounts with access to all projects.
--
-- What PostgreSQL enforces here:
--   * project scope — private.scope_projects() (used by every analytics
--     function), the functions that read projects/tickets/import runs directly,
--     and RLS on projects, tickets, classifications, attachments, changes,
--     import runs and reporting cycles;
--   * every sensitive permission — message text, ticket-row exports, imports,
--     project/cycle/category/settings changes, the audit log — and the Ticket
--     Explorer page (search_tickets, get_ticket_detail).
-- The remaining page.* permissions decide which pages the application serves
-- and shows; the aggregates behind them are shared by several pages, so the
-- database scopes them by project but does not know which page asked.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Permission catalog (mirrored by src/lib/auth/permissions.ts; a unit test keeps
-- the two lists identical)
-- -----------------------------------------------------------------------------
create or replace function private.permission_catalog()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'page.overview',
    'page.projects',
    'page.trends',
    'page.topics',
    'page.team',
    'page.backlog',
    'page.tickets',
    'page.insights',
    'page.data_quality',
    'page.reports',
    'page.settings',
    'tickets.read_content',
    'export.aggregate',
    'export.tickets',
    'imports.manage',
    'projects.manage',
    'categories.manage',
    'settings.manage',
    'audit.view'
  ]::text[];
$$;

-- Permissions that act across projects and cycles: only effective with access to all projects.
create or replace function private.global_permissions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['projects.manage', 'imports.manage']::text[];
$$;

-- -----------------------------------------------------------------------------
-- Roles
-- -----------------------------------------------------------------------------
create table public.app_roles (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text not null check (length(btrim(name)) between 1 and 60),
  description text check (description is null or length(description) <= 500),
  permissions text[] not null default '{}' check (permissions <@ private.permission_catalog()),
  -- System roles cannot be deleted ('admin' cannot be edited either).
  is_system boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index app_roles_name_key on public.app_roles (lower(btrim(name)));

comment on table public.app_roles is
  'Named application roles. permissions holds keys from private.permission_catalog(); the admin role always has all of them.';

create trigger app_roles_touch_updated_at
before update on public.app_roles
for each row execute function private.touch_updated_at();

insert into public.app_roles (code, name, description, permissions, is_system) values
  ('admin', 'Administrator',
   'Full access to every page, message text, exports, imports and settings, plus user and role management.',
   private.permission_catalog(), true),
  ('analyst', 'Analyst',
   'Every dashboard page and aggregated CSV exports. No message text or ticket-row exports; settings are read-only.',
   array['page.overview', 'page.projects', 'page.trends', 'page.topics', 'page.team', 'page.backlog',
         'page.tickets', 'page.insights', 'page.data_quality', 'page.reports', 'page.settings',
         'export.aggregate']::text[], true);

-- -----------------------------------------------------------------------------
-- Accounts: role reference and project scope
-- -----------------------------------------------------------------------------
alter table public.user_roles drop constraint user_roles_role_check;
alter table public.user_roles
  add constraint user_roles_role_fkey foreign key (role) references public.app_roles (code) on delete restrict;
alter table public.user_roles add column all_projects boolean not null default true;
alter table public.user_roles
  add constraint user_roles_admin_all_projects check (role <> 'admin' or all_projects);
create index user_roles_role_idx on public.user_roles (role);

comment on column public.user_roles.all_projects is
  'true: every project. false: only the programs in user_program_access and the projects in user_project_access.';

create table public.user_program_access (
  user_id uuid not null references public.user_roles (user_id) on delete cascade,
  program text not null check (program ~ '^[A-Z][A-Z0-9]{1,19}$'),
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, program)
);

comment on table public.user_program_access is
  'Programs a restricted account may see, including projects of that program created later.';

create table public.user_project_access (
  user_id uuid not null references public.user_roles (user_id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

create index user_project_access_project_idx on public.user_project_access (project_id);

comment on table public.user_project_access is 'Individual projects a restricted account may see.';

-- -----------------------------------------------------------------------------
-- Permission and scope helpers (private schema, not callable through the Data API)
-- -----------------------------------------------------------------------------

-- Effective permissions of the caller, in catalog order (null without a role).
create or replace function private.current_permissions()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when ur.role = 'admin' then private.permission_catalog()
    else array(
      select k
      from unnest(private.permission_catalog()) with ordinality as c(k, i)
      where k = any (r.permissions)
        and (ur.all_projects or not (k = any (private.global_permissions())))
      order by i)
  end
  from public.user_roles ur
  join public.app_roles r on r.code = ur.role
  where ur.user_id = (select auth.uid());
$$;

create or replace function private.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_permission = any (private.current_permissions()), false);
$$;

-- Raises insufficient_privilege unless the caller's role grants p_permission.
create or replace function private.require_permission(p_permission text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := private.current_app_role();
begin
  if not (p_permission = any (private.permission_catalog())) then
    raise exception 'Unknown permission %', p_permission;
  end if;
  if v_role is null then
    raise exception 'Access denied: no application role assigned'
      using errcode = '42501';
  end if;
  if not private.has_permission(p_permission) then
    raise exception 'Access denied: your role does not include the "%" permission', p_permission
      using errcode = '42501';
  end if;
  return v_role;
end;
$$;

create or replace function private.sees_all_projects()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select ur.all_projects from public.user_roles ur where ur.user_id = (select auth.uid())), false);
$$;

-- Projects (of any status) inside the caller's project scope. Use as
-- `x.project_id in (select private.visible_project_ids())`: evaluated once per query.
create or replace function private.visible_project_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.projects p
  join public.user_roles ur on ur.user_id = (select auth.uid())
  where ur.all_projects
     or exists (select 1 from public.user_program_access g where g.user_id = ur.user_id and g.program = p.program)
     or exists (select 1 from public.user_project_access a where a.user_id = ur.user_id and a.project_id = p.id);
$$;

-- Any assigned role (custom roles included) grants baseline access.
create or replace function private.has_app_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_app_role() is not null;
$$;

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table public.app_roles enable row level security;
alter table public.user_program_access enable row level security;
alter table public.user_project_access enable row level security;

-- Written only through the audited, administrator-checked functions below.
revoke all on public.app_roles, public.user_program_access, public.user_project_access from anon, authenticated;
grant select on public.app_roles, public.user_program_access, public.user_project_access to authenticated;

create policy app_roles_select on public.app_roles
  for select to authenticated
  using (code = (select private.current_app_role()) or (select private.is_admin()));
create policy user_program_access_select on public.user_program_access
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy user_project_access_select on public.user_project_access
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

-- Project scope on direct table reads.
drop policy projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated using (
    (select private.has_app_access()) and status <> 'draft'
    and id in (select private.visible_project_ids()));

drop policy tickets_select on public.tickets;
create policy tickets_select on public.tickets
  for select to authenticated using (
    (select private.has_app_access())
    and project_id in (select private.visible_project_ids())
    and exists (select 1 from public.projects p where p.id = project_id and p.status <> 'draft'));

drop policy ticket_classifications_select on public.ticket_classifications;
create policy ticket_classifications_select on public.ticket_classifications
  for select to authenticated using (
    (select private.has_app_access())
    and ticket_pk in (select t.id from public.tickets t where t.project_id in (select private.visible_project_ids())));

drop policy ticket_attachments_select on public.ticket_attachments;
create policy ticket_attachments_select on public.ticket_attachments
  for select to authenticated using (
    (select private.has_permission('tickets.read_content'))
    and ticket_pk in (select t.id from public.tickets t where t.project_id in (select private.visible_project_ids())));

-- Previous values of changed fields can include message text.
drop policy ticket_changes_select on public.ticket_changes;
create policy ticket_changes_select on public.ticket_changes
  for select to authenticated using (
    (select private.has_permission('tickets.read_content'))
    and ticket_pk in (select t.id from public.tickets t where t.project_id in (select private.visible_project_ids())));

drop policy import_runs_select on public.import_runs;
create policy import_runs_select on public.import_runs
  for select to authenticated using (
    (select private.has_app_access())
    and case when project_id is null then (select private.sees_all_projects())
             else project_id in (select private.visible_project_ids()) end);

drop policy reporting_cycles_select on public.reporting_cycles;
create policy reporting_cycles_select on public.reporting_cycles
  for select to authenticated using (
    (select private.has_app_access()) and status <> 'draft'
    and ((select private.sees_all_projects())
         or exists (select 1 from public.projects p
                    where p.cycle_id = reporting_cycles.id and p.id in (select private.visible_project_ids()))));

drop policy import_errors_select on public.import_errors;
create policy import_errors_select on public.import_errors
  for select to authenticated using ((select private.has_permission('imports.manage')));

drop policy import_jobs_select on public.import_jobs;
create policy import_jobs_select on public.import_jobs
  for select to authenticated using ((select private.has_permission('imports.manage')));

drop policy import_job_issues_select on public.import_job_issues;
create policy import_job_issues_select on public.import_job_issues
  for select to authenticated using ((select private.has_permission('imports.manage')));

drop policy import_job_events_select on public.import_job_events;
create policy import_job_events_select on public.import_job_events
  for select to authenticated using ((select private.has_permission('imports.manage')));

drop policy audit_events_select on public.audit_events;
create policy audit_events_select on public.audit_events
  for select to authenticated using ((select private.has_permission('audit.view')));

drop policy analytics_thresholds_update on public.analytics_thresholds;
create policy analytics_thresholds_update on public.analytics_thresholds
  for update to authenticated
  using ((select private.has_permission('settings.manage')))
  with check ((select private.has_permission('settings.manage')));

drop policy app_settings_insert on public.app_settings;
create policy app_settings_insert on public.app_settings
  for insert to authenticated with check ((select private.has_permission('settings.manage')));
drop policy app_settings_update on public.app_settings;
create policy app_settings_update on public.app_settings
  for update to authenticated
  using ((select private.has_permission('settings.manage')))
  with check ((select private.has_permission('settings.manage')));

-- =============================================================================
-- Existing functions. Each is its latest definition, unchanged except for the
-- permission check (replacing the administrator check) and/or the project scope.
-- =============================================================================

create or replace function private.scope_projects(f jsonb)
returns setof projects
language sql
stable
set search_path = ''
as $$
  select p.*
  from public.projects p
  join public.reporting_cycles rc on rc.id = p.cycle_id
  where rc.id = private.scope_cycle_id(f)
    and p.id in (select private.visible_project_ids())
    and (p.status = 'active'
         or (p.status = 'archived' and (rc.status = 'archived' or coalesce(f -> 'include_archived' = 'true'::jsonb, false))))
    and (private.jarr(f -> 'projects') is null or p.code = any (private.jarr(f -> 'projects')))
    and (private.jarr(f -> 'programs') is null or p.program = any (private.jarr(f -> 'programs')))
    and (private.jarr(f -> 'intakes') is null or p.intake = any (private.jarr(f -> 'intakes')));
$$;

create or replace function public.get_scope_catalog()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role('analyst');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', rc.code, 'name', rc.name, 'status', rc.status, 'is_current', rc.is_current,
      'archived_at', rc.archived_at,
      'projects', coalesce((
        select jsonb_agg(jsonb_build_object(
          'code', p.code, 'name', p.name, 'status', p.status,
          'tickets', (select count(*) from public.tickets t where t.project_id = p.id),
          'snapshot_at', s.snapshot_at) order by p.display_order, p.code)
        from public.projects p
        left join private.project_snapshots s on s.project_id = p.id
        where p.cycle_id = rc.id and p.status <> 'draft'
          and p.id in (select private.visible_project_ids())), '[]'::jsonb))
      order by rc.is_current desc, (rc.status = 'archived'), rc.display_order, rc.created_at desc)
    from public.reporting_cycles rc
    where rc.status <> 'draft'
      and (private.sees_all_projects() or exists (
        select 1 from public.projects p2
        where p2.cycle_id = rc.id and p2.status <> 'draft' and p2.id in (select private.visible_project_ids())))), '[]'::jsonb);
end;
$$;

create or replace function public.search_tickets(p_filters jsonb default '{}'::jsonb, p_search text default null::text, p_sort text default 'created_at'::text, p_dir text default 'desc'::text, p_page integer default 1, p_page_size integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := private.require_permission('page.tickets');
  v_content boolean := private.has_permission('tickets.read_content');
  v_sort_col text;
  v_dir text := case when lower(coalesce(p_dir, 'desc')) = 'asc' then 'asc' else 'desc' end;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_like text;
  v_id bigint;
  v_total bigint;
  v_rows jsonb;
  v_sql text;
begin
  p_page := greatest(coalesce(p_page, 1), 1);
  p_page_size := least(greatest(coalesce(p_page_size, 25), 1), 100);

  v_sort_col := case p_sort
    when 'ticket_id' then 't.ticket_id'
    when 'project' then 'p.display_order'
    when 'topic' then 't.topic'
    when 'status' then 't.status'
    when 'owner_id' then 't.owner_id'
    when 'created_at' then 't.created_at'
    when 'responded_at' then 't.responded_at'
    when 'resolved_at' then 't.resolved_at'
    when 'responder_name' then 't.responder_name'
    when 'resolved_by' then 't.resolved_by'
    when 'response_seconds' then 't.response_seconds'
    when 'resolution_seconds' then 't.resolution_seconds'
    else 't.created_at'
  end;

  if v_search is not null then
    if length(v_search) > 200 then
      raise exception 'Search text too long' using errcode = '22023';
    end if;
    v_like := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    if v_search ~ '^[0-9]{1,18}$' then
      v_id := v_search::bigint;
    end if;
  end if;

  v_sql := format($q$
    with f as (
      select t.*
      from private.filtered_tickets($1) t
      where $2::text is null
         or t.ticket_id = $3
         or t.owner_id ilike $2
         or t.topic ilike $2
         or t.lesson_name ilike $2
         or t.session_ref = $4
         or t.responder_name ilike $2
         or t.resolved_by ilike $2
         or ($5 and (t.message ilike $2 or t.note ilike $2 or t.response ilike $2))
    )
    select
      (select count(*) from f),
      coalesce((
        select jsonb_agg(r.j order by r.ord)
        from (
          select row_number() over (order by %1$s %2$s nulls last, t.ticket_id %2$s, t.id %2$s) as ord,
            jsonb_build_object(
              'ticket_id', t.ticket_id,
              'project_code', p.code,
              'project_name', p.name,
              'project_status', p.status,
              'topic', t.topic,
              'status', t.status,
              'owner_id', t.owner_id,
              'created_at', t.created_at,
              'responded_at', t.responded_at,
              'resolved_at', t.resolved_at,
              'responder_name', t.responder_name,
              'resolved_by', t.resolved_by,
              'response_seconds', t.response_seconds,
              'resolution_seconds', t.resolution_seconds,
              'response_kind', t.response_kind,
              'lesson_name', t.lesson_name,
              'category', cat.name_en,
              'subcategory', sub.name_en
            ) as j
          from f t
          join public.projects p on p.id = t.project_id
          left join public.ticket_classifications c on c.ticket_pk = t.id and c.is_current
          left join public.ticket_categories cat on cat.id = c.category_id
          left join public.ticket_categories sub on sub.id = c.subcategory_id
          order by %1$s %2$s nulls last, t.ticket_id %2$s, t.id %2$s
          limit $6 offset $7
        ) r
      ), '[]'::jsonb)
  $q$, v_sort_col, v_dir);

  execute v_sql
    into v_total, v_rows
    using coalesce(p_filters, '{}'::jsonb), v_like, v_id, v_search, v_content,
          p_page_size, (p_page - 1) * p_page_size;

  return jsonb_build_object(
    'total', v_total,
    'page', p_page,
    'page_size', p_page_size,
    'sort', p_sort,
    'dir', v_dir,
    'content_search', v_content,
    'rows', v_rows
  );
end;
$$;

create or replace function public.get_ticket_detail(p_ticket_id bigint, p_project_code text default null::text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := private.require_permission('page.tickets');
  v_content boolean := private.has_permission('tickets.read_content');
  v_pk bigint;
  v_candidates jsonb;
  v jsonb;
begin
  select jsonb_agg(jsonb_build_object('project_code', p.code, 'project_name', p.name, 'project_status', p.status,
                                      'cycle', rc.code, 'cycle_name', rc.name) order by p.status, p.display_order),
         min(t.id)
    into v_candidates, v_pk
  from public.tickets t
  join public.projects p on p.id = t.project_id
  join public.reporting_cycles rc on rc.id = p.cycle_id
  where t.ticket_id = p_ticket_id
    and p.status <> 'draft'
    and p.id in (select private.visible_project_ids())
    and (nullif(p_project_code, '') is null or p.code = p_project_code);

  if v_candidates is null then
    return null;
  end if;
  if jsonb_array_length(v_candidates) > 1 then
    return jsonb_build_object('ambiguous', true, 'ticket_id', p_ticket_id, 'candidates', v_candidates);
  end if;

  select jsonb_build_object(
    'ticket_id', t.ticket_id,
    'project_code', p.code,
    'project_name', p.name,
    'project_status', p.status,
    'cycle', rc.code,
    'cycle_name', rc.name,
    'organization_id', t.organization_id,
    'topic', t.topic,
    'status', t.status,
    'status_class', private.status_class(t.status),
    'priority', t.priority,
    'department', t.department,
    'owner_type', t.owner_type,
    'owner_id', t.owner_id,
    'affected_student_id', t.affected_student_id,
    'created_at', t.created_at,
    'responded_at', t.responded_at,
    'resolved_at', t.resolved_at,
    'response_seconds', t.response_seconds,
    'resolution_seconds', t.resolution_seconds,
    'responder_name', t.responder_name,
    'resolved_by', t.resolved_by,
    'response_kind', t.response_kind,
    'sub_topic', t.sub_topic,
    'session_ref', t.session_ref,
    'lesson_name', t.lesson_name,
    'message_language', t.message_language,
    'source_filename', t.source_filename,
    'source_row_number', t.source_row_number,
    'source_data_as_of', t.source_data_as_of,
    'imported_at', t.imported_at,
    'updated_at', t.updated_at,
    'category', cat.name_en,
    'subcategory', sub.name_en,
    'classification', case when c.id is null then null else jsonb_build_object(
      'method', c.method, 'version', c.version, 'confidence', c.confidence, 'evidence', c.evidence) end,
    'content_visible', v_content,
    'message', case when v_content then t.message end,
    'response', case when v_content then t.response end,
    'note', case when v_content then t.note end,
    'attachments', case when v_content then coalesce((
      select jsonb_agg(jsonb_build_object('type', a.attachment_type, 'position', a.position,
                                          'url', a.url, 'host', a.url_host, 'file_name', a.file_name,
                                          'extension', a.file_extension)
                       order by a.attachment_type, a.position)
      from public.ticket_attachments a where a.ticket_pk = t.id), '[]'::jsonb) end,
    'attachment_count', (select count(*) from public.ticket_attachments a where a.ticket_pk = t.id),
    -- Import history: field names for everyone, previous values for administrators only.
    'changes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'changed_at', h.changed_at,
        'fields', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(h.changes) k),
        'values', case when v_content then h.changes end,
        'source_filename', r.source_filename) order by h.changed_at desc)
      from (select * from public.ticket_changes h2 where h2.ticket_pk = t.id order by h2.changed_at desc limit 20) h
      left join public.import_runs r on r.id = h.import_run_id), '[]'::jsonb)
  )
  into v
  from public.tickets t
  join public.projects p on p.id = t.project_id
  join public.reporting_cycles rc on rc.id = p.cycle_id
  left join public.ticket_classifications c on c.ticket_pk = t.id and c.is_current
  left join public.ticket_categories cat on cat.id = c.category_id
  left join public.ticket_categories sub on sub.id = c.subcategory_id
  where t.id = v_pk;

  if v is not null and v_content then
    perform private.log_audit('ticket.view_content', jsonb_build_object('ticket_id', p_ticket_id, 'project', v ->> 'project_code'));
  end if;

  return v;
end;
$$;

create or replace function public.export_tickets_page(p_filters jsonb default '{}'::jsonb, p_after_pk bigint default 0, p_limit integer default 1000, p_include_text boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.require_permission('export.tickets');
  if p_include_text then
    perform private.require_permission('tickets.read_content');
  end if;
  p_limit := least(greatest(coalesce(p_limit, 1000), 1), 1000);

  select coalesce(jsonb_agg(x.j order by x.pk), '[]'::jsonb)
    into v
  from (
    select t.id as pk, jsonb_build_object(
      '_pk', t.id,
      'ticket_id', t.ticket_id,
      'project', p.name,
      'organization_id', t.organization_id,
      'topic', t.topic,
      'status', t.status,
      'department', t.department,
      'owner_type', t.owner_type,
      'owner_id', t.owner_id,
      'created_at', t.created_at,
      'responded_at', t.responded_at,
      'resolved_at', t.resolved_at,
      'recorded_response_hours', round(t.response_seconds / 3600.0, 2),
      'resolution_hours', round(t.resolution_seconds / 3600.0, 2),
      'responder_name', t.responder_name,
      'resolved_by', t.resolved_by,
      'response_kind', t.response_kind,
      'sub_topic', t.sub_topic,
      'session_ref', t.session_ref,
      'lesson_name', t.lesson_name,
      'category', cat.name_en,
      'subcategory', sub.name_en,
      'message', case when p_include_text then t.message end,
      'response', case when p_include_text then t.response end,
      'note', case when p_include_text then t.note end
    ) as j
    from private.filtered_tickets(coalesce(p_filters, '{}'::jsonb)) t
    join public.projects p on p.id = t.project_id
    left join public.ticket_classifications c on c.ticket_pk = t.id and c.is_current
    left join public.ticket_categories cat on cat.id = c.category_id
    left join public.ticket_categories sub on sub.id = c.subcategory_id
    where t.id > coalesce(p_after_pk, 0)
    order by t.id
    limit p_limit
  ) x;

  return v;
end;
$$;

create or replace function public.get_import_runs(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.require_role('analyst');
  select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc), '[]'::jsonb)
    into v
  from (
    select r.id, r.source_filename, p.code as project, p.name as project_name, p.status as project_status,
      r.file_hash, r.file_size_bytes, r.started_at, r.completed_at, r.status, r.records_in_file,
      r.inserted_count, r.updated_count, r.skipped_unchanged_count, r.skipped_stale_count,
      r.skipped_count, r.rejected_count, r.data_as_of, r.min_created_at, r.max_created_at,
      r.duplicate_of_run_id, r.update_policy, r.importer_version, r.error_summary,
      r.source, r.invalid_row_policy,
      (select j.id from public.import_jobs j where j.import_run_id = r.id) as job_id
    from public.import_runs r
    left join public.projects p on p.id = r.project_id
    where case when r.project_id is null then private.sees_all_projects()
               else r.project_id in (select private.visible_project_ids()) end
    order by r.started_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 500)
  ) x;
  return v;
end;
$$;

create or replace function public.get_import_run_detail(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := private.require_role('analyst');
  v_raw boolean := private.has_permission('imports.manage');
  v_run jsonb;
  v_errors jsonb;
begin
  select to_jsonb(x) into v_run
  from (
    select r.*, p.code as project, p.name as project_name, p.status as project_status,
      (select j.id from public.import_jobs j where j.import_run_id = r.id) as job_id
    from public.import_runs r
    left join public.projects p on p.id = r.project_id
    where r.id = p_run_id
      and case when r.project_id is null then private.sees_all_projects()
               else r.project_id in (select private.visible_project_ids()) end
  ) x;

  if v_run is null then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'source_row_number', e.source_row_number, 'ticket_id', e.ticket_id,
           'error_code', e.error_code, 'validation_error', e.validation_error,
           'raw_row', case when v_raw then e.raw_row end,
           'recorded_at', e.recorded_at) order by e.source_row_number nulls first, e.id), '[]'::jsonb)
    into v_errors
  from (select * from public.import_errors e2 where e2.import_run_id = p_run_id order by e2.id limit 1000) e;

  return jsonb_build_object('run', v_run, 'errors', v_errors, 'raw_rows_visible', v_raw);
end;
$$;

create or replace function public.get_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin boolean;
begin
  perform private.require_role('analyst');
  -- Draft cycles and projects (an archive-and-start-new import in progress) are
  -- shown to the people who manage projects or imports.
  v_admin := private.has_permission('projects.manage') or private.has_permission('imports.manage');
  return jsonb_build_object(
    'thresholds', coalesce((select jsonb_agg(to_jsonb(th) order by th.key) from public.analytics_thresholds th), '[]'::jsonb),
    'app', coalesce((select jsonb_object_agg(s.key, s.value) from public.app_settings s), '{}'::jsonb),
    'insight_rules', coalesce((
      select jsonb_agg(jsonb_build_object('key', r.key, 'value', r.value, 'min_value', r.min_value,
                                          'max_value', r.max_value, 'unit', r.unit, 'label', r.label,
                                          'description', r.description, 'updated_at', r.updated_at)
                       order by r.sort_order, r.key)
      from public.insight_rules r), '[]'::jsonb),
    'cycles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rc.id, 'code', rc.code, 'name', rc.name, 'description', rc.description, 'status', rc.status,
        'is_current', rc.is_current, 'archived_at', rc.archived_at, 'archive_reason', rc.archive_reason,
        'created_at', rc.created_at,
        'projects', (select count(*) from public.projects p where p.cycle_id = rc.id and p.status <> 'draft'
                      and p.id in (select private.visible_project_ids())))
        order by rc.is_current desc, (rc.status = 'archived'), rc.display_order, rc.created_at desc)
      from public.reporting_cycles rc
      where (rc.status <> 'draft' or v_admin)
        and (private.sees_all_projects() or exists (
          select 1 from public.projects p2
          where p2.cycle_id = rc.id and p2.status <> 'draft' and p2.id in (select private.visible_project_ids())))), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'code', p.code, 'name', p.name, 'program', p.program, 'intake', p.intake,
        'intake_group', p.intake_group, 'organization_id', p.organization_id, 'description', p.description,
        'file_name_hint', p.file_name_hint, 'display_order', p.display_order,
        'status', p.status, 'is_active', p.status = 'active',
        'cycle', rc.code, 'cycle_name', rc.name, 'cycle_status', rc.status,
        'archived_at', p.archived_at, 'archive_reason', p.archive_reason, 'archived_via', p.archived_via,
        'created_at', p.created_at,
        'tickets', (select count(*) from public.tickets t where t.project_id = p.id),
        'last_import', (
          select jsonb_build_object('completed_at', r.completed_at, 'data_as_of', r.data_as_of,
                                    'source_filename', r.source_filename, 'status', r.status, 'source', r.source)
          from public.import_runs r
          where r.project_id = p.id and r.status in ('completed', 'completed_with_errors')
          order by r.completed_at desc limit 1),
        'snapshot_at', (select s.snapshot_at from private.project_snapshots s where s.project_id = p.id),
        'imports', (select count(*) from public.import_runs r where r.project_id = p.id),
        'active_job', (
          select jsonb_build_object('id', j.id, 'status', j.status)
          from public.import_jobs j
          where j.project_id = p.id and j.status in ('importing', 'validating', 'uploaded', 'ready')
          order by j.created_at desc limit 1))
        order by rc.is_current desc, p.display_order, p.code)
      from public.projects p
      join public.reporting_cycles rc on rc.id = p.cycle_id
      where (p.status <> 'draft' or v_admin)
        and p.id in (select private.visible_project_ids())), '[]'::jsonb)
  );
end;
$$;

create or replace function public.get_project_history(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_role('analyst');
  select id into v_id from public.projects where code = p_code and status <> 'draft'
    and id in (select private.visible_project_ids());
  if v_id is null then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'source_filename', r.source_filename, 'source', r.source, 'status', r.status,
      'started_at', r.started_at, 'completed_at', r.completed_at, 'data_as_of', r.data_as_of,
      'records_in_file', r.records_in_file, 'inserted_count', r.inserted_count, 'updated_count', r.updated_count,
      'skipped_unchanged_count', r.skipped_unchanged_count, 'skipped_stale_count', r.skipped_stale_count,
      'rejected_count', r.rejected_count,
      'job_id', (select j.id from public.import_jobs j where j.import_run_id = r.id)) order by r.started_at desc)
    from public.import_runs r where r.project_id = v_id), '[]'::jsonb);
end;
$$;

create or replace function public.get_status_values()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role('analyst');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'status', x.status, 'tickets', x.n, 'class', st.status_class, 'label', st.label,
      'configured', st.status is not null, 'updated_at', st.updated_at)
      order by (st.status is not null), x.n desc, x.status)
    from (
      select coalesce(t.status, '__none__') as status, count(*) as n
      from public.tickets t join public.projects p on p.id = t.project_id
      where p.status <> 'draft' and p.id in (select private.visible_project_ids())
      group by 1
      union all
      select s.status, 0 from public.ticket_statuses s
      where not exists (select 1 from public.tickets t where coalesce(t.status, '__none__') = s.status
                          and t.project_id in (select private.visible_project_ids()))
    ) x
    left join public.ticket_statuses st on st.status = x.status), '[]'::jsonb);
end;
$$;

create or replace function public.get_topic_mappings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role('analyst');
  return jsonb_build_object(
    'topics', coalesce((
      select jsonb_agg(jsonb_build_object(
        'topic', x.topic, 'tickets', x.tickets, 'current_cycle_tickets', x.cur, 'projects', x.projects,
        'first_seen', x.first_seen, 'category', k.code, 'category_name', k.name_en,
        'mapped', m.topic is not null, 'source', m.source, 'updated_at', m.updated_at)
        order by (m.topic is not null), x.tickets desc, x.topic)
      from (
        select t.topic, count(*) as tickets,
          count(*) filter (where p.cycle_id = private.scope_cycle_id('{}'::jsonb)) as cur,
          array_agg(distinct p.code) as projects, min(t.imported_at) as first_seen
        from public.tickets t join public.projects p on p.id = t.project_id
        where p.status <> 'draft' and p.id in (select private.visible_project_ids())
        group by t.topic
        union all
        -- Mapped topics without tickets yet (e.g. prepared in advance).
        select m2.topic, 0, 0, '{}'::text[], null
        from public.topic_categories m2
        where not exists (select 1 from public.tickets t2 where t2.topic = m2.topic and t2.project_id in (select private.visible_project_ids()))
      ) x
      left join public.topic_categories m on m.topic = x.topic
      left join public.ticket_categories k on k.id = m.category_id), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('code', k.code, 'name', k.name_en, 'name_ar', k.name_ar,
                                          'description', k.description, 'kind', k.kind, 'is_active', k.is_active,
                                          'sort_order', k.sort_order,
                                          'topics', (select count(*) from public.topic_categories m where m.category_id = k.id))
                       order by k.kind, k.sort_order, k.code)
      from public.ticket_categories k), '[]'::jsonb)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Administrator check -> specific permission
-- -----------------------------------------------------------------------------

create or replace function public.update_threshold(p_key text, p_value_hours numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old numeric;
begin
  perform private.require_permission('settings.manage');
  if p_value_hours is null or p_value_hours <= 0 or p_value_hours > 8760 then
    raise exception 'Threshold must be between 0 and 8760 hours' using errcode = '22023';
  end if;
  select value_hours into v_old from public.analytics_thresholds where key = p_key;
  if not found then
    raise exception 'Unknown threshold %', p_key using errcode = '22023';
  end if;
  update public.analytics_thresholds
     set value_hours = round(p_value_hours, 2), updated_by = (select auth.uid())
   where key = p_key;
  perform private.log_audit('settings.threshold_update',
    jsonb_build_object('key', p_key, 'old', v_old, 'new', round(p_value_hours, 2)));
  return jsonb_build_object('key', p_key, 'value_hours', round(p_value_hours, 2));
end;
$$;

create or replace function public.update_app_setting(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('settings.manage');
  if p_key = 'date_preset_anchor' and not (p_value in ('"dataset_end"'::jsonb, '"today"'::jsonb)) then
    raise exception 'Invalid value for date_preset_anchor' using errcode = '22023';
  elsif p_key = 'default_date_preset' and not (p_value in ('"all"'::jsonb, '"last_7"'::jsonb, '"last_30"'::jsonb,
                                                           '"last_90"'::jsonb, '"this_month"'::jsonb)) then
    raise exception 'Invalid value for default_date_preset' using errcode = '22023';
  elsif p_key = 'organization_name' and (jsonb_typeof(p_value) <> 'string'
                                         or length(p_value #>> '{}') not between 1 and 80) then
    raise exception 'Invalid organization name' using errcode = '22023';
  elsif p_key not in ('date_preset_anchor', 'default_date_preset', 'organization_name') then
    raise exception 'Unknown setting %', p_key using errcode = '22023';
  end if;

  insert into public.app_settings (key, value, updated_by)
  values (p_key, p_value, (select auth.uid()))
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;

  perform private.log_audit('settings.app_update', jsonb_build_object('key', p_key, 'value', p_value));
  return jsonb_build_object('key', p_key, 'value', p_value);
end;
$$;

create or replace function public.update_insight_rule(p_key text, p_value numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.insight_rules%rowtype;
begin
  perform private.require_permission('settings.manage');
  select * into v_rule from public.insight_rules where key = p_key for update;
  if v_rule.key is null then
    raise exception 'Unknown insight rule %', p_key using errcode = '22023';
  end if;
  if p_value is null or p_value < v_rule.min_value or p_value > v_rule.max_value then
    raise exception '% must be between % and %.', v_rule.label, v_rule.min_value, v_rule.max_value using errcode = '22023';
  end if;
  update public.insight_rules set value = p_value, updated_by = (select auth.uid()) where key = p_key;
  perform private.log_audit('settings.insight_rule_update', jsonb_build_object('key', p_key, 'old', v_rule.value, 'new', p_value));
  return jsonb_build_object('key', p_key, 'value', p_value);
end;
$$;

create or replace function public.create_reporting_cycle(p_cycle jsonb, p_make_current boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_id uuid;
begin
  perform private.require_permission('projects.manage');
  v := private.validate_cycle_spec(p_cycle);
  if p_make_current then
    update public.reporting_cycles set is_current = false where is_current;
  end if;
  insert into public.reporting_cycles (code, name, description, status, is_current, display_order, created_by)
  values (v ->> 'code', v ->> 'name', v ->> 'description', 'active', coalesce(p_make_current, false),
          (select coalesce(max(display_order), 0) + 1 from public.reporting_cycles), (select auth.uid()))
  returning id into v_id;
  perform private.log_audit('cycle.create', v || jsonb_build_object('id', v_id, 'make_current', p_make_current));
  return v || jsonb_build_object('id', v_id);
end;
$$;

create or replace function public.update_reporting_cycle(p_code text, p_name text, p_description text default null::text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('projects.manage');
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception 'Cycle name is required (max 120 characters).' using errcode = '22023';
  end if;
  update public.reporting_cycles
     set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), '')
   where code = p_code and status <> 'draft';
  if not found then
    raise exception 'Unknown reporting cycle %', p_code using errcode = '22023';
  end if;
  perform private.log_audit('cycle.update', jsonb_build_object('code', p_code, 'name', btrim(p_name)));
  return jsonb_build_object('code', p_code);
end;
$$;

create or replace function public.set_current_cycle(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_permission('projects.manage');
  select id into v_id from public.reporting_cycles where code = p_code and status = 'active' for update;
  if v_id is null then
    raise exception 'Only an active reporting cycle can be made current.' using errcode = '22023';
  end if;
  update public.reporting_cycles set is_current = false where is_current and id <> v_id;
  update public.reporting_cycles set is_current = true where id = v_id;
  perform private.log_audit('cycle.set_current', jsonb_build_object('code', p_code));
  return jsonb_build_object('code', p_code, 'is_current', true);
end;
$$;

create or replace function public.archive_cycle(p_code text, p_reason text, p_confirm text, p_new_current text default null::text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cycle public.reporting_cycles%rowtype;
  v_projects uuid[];
  v_new uuid;
begin
  perform private.require_permission('projects.manage');
  select * into v_cycle from public.reporting_cycles where code = p_code for update;
  if v_cycle.id is null or v_cycle.status <> 'active' then
    raise exception 'Only an active reporting cycle can be archived.' using errcode = '22023';
  end if;
  if coalesce(p_confirm, '') <> v_cycle.code then
    raise exception 'Confirmation does not match: type the cycle code % to archive it.', v_cycle.code using errcode = '22023';
  end if;
  select array_agg(id) into v_projects from public.projects where cycle_id = v_cycle.id and status = 'active';
  perform 1 from public.projects where id = any (coalesce(v_projects, '{}')) for update;
  perform private.assert_no_running_import(coalesce(v_projects, '{}'));

  if nullif(p_new_current, '') is not null then
    select id into v_new from public.reporting_cycles where code = p_new_current and status = 'active' and id <> v_cycle.id;
    if v_new is null then
      raise exception 'The cycle chosen to become current must be another active cycle.' using errcode = '22023';
    end if;
  end if;

  update public.projects
     set status = 'archived', archived_at = now(), archived_by = (select auth.uid()),
         archive_reason = nullif(btrim(coalesce(p_reason, '')), ''), archived_via = 'cycle'
   where id = any (coalesce(v_projects, '{}'));
  update public.reporting_cycles
     set status = 'archived', is_current = false, archived_at = now(), archived_by = (select auth.uid()),
         archive_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = v_cycle.id;
  if v_new is not null then
    update public.reporting_cycles set is_current = true where id = v_new;
  end if;

  perform private.log_audit('cycle.archive', jsonb_build_object(
    'code', v_cycle.code, 'projects', coalesce(array_length(v_projects, 1), 0), 'reason', p_reason, 'new_current', p_new_current));
  return jsonb_build_object('code', v_cycle.code, 'archived_projects', coalesce(array_length(v_projects, 1), 0));
end;
$$;

create or replace function public.restore_cycle(p_code text, p_make_current boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cycle public.reporting_cycles%rowtype;
  v_project record;
  v_restored integer := 0;
begin
  perform private.require_permission('projects.manage');
  select * into v_cycle from public.reporting_cycles where code = p_code for update;
  if v_cycle.id is null or v_cycle.status <> 'archived' then
    raise exception 'Only an archived reporting cycle can be restored.' using errcode = '22023';
  end if;
  -- Projects archived together with the cycle are restored with it.
  for v_project in
    select * from public.projects where cycle_id = v_cycle.id and status = 'archived' and archived_via = 'cycle' for update
  loop
    perform private.assert_org_available(v_project.organization_id, array[v_project.id]);
    update public.projects
       set status = 'active', archived_at = null, archived_by = null, archive_reason = null, archived_via = null
     where id = v_project.id;
    v_restored := v_restored + 1;
  end loop;
  if p_make_current then
    update public.reporting_cycles set is_current = false where is_current;
  end if;
  update public.reporting_cycles
     set status = 'active', archived_at = null, archived_by = null, archive_reason = null,
         is_current = coalesce(p_make_current, false)
   where id = v_cycle.id;
  perform private.log_audit('cycle.restore', jsonb_build_object('code', p_code, 'projects', v_restored, 'make_current', p_make_current));
  return jsonb_build_object('code', p_code, 'restored_projects', v_restored);
end;
$$;

create or replace function public.create_project(p_project jsonb, p_cycle text default null::text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_cycle uuid;
  v_id uuid;
begin
  perform private.require_permission('projects.manage');
  v := private.validate_project_spec(p_project);
  select id into v_cycle from public.reporting_cycles
   where status = 'active' and case when nullif(p_cycle, '') is null then is_current else code = p_cycle end;
  if v_cycle is null then
    raise exception 'Choose an active reporting cycle for the new project.' using errcode = '22023';
  end if;
  if exists (select 1 from public.projects where code = v ->> 'code') then
    raise exception 'A project with code % already exists (codes stay reserved, including archived projects).', v ->> 'code' using errcode = '22023';
  end if;
  perform private.assert_org_available((v ->> 'organization_id')::integer);
  insert into public.projects (code, name, program, intake, intake_group, organization_id, file_name_hint,
                               display_order, description, cycle_id, status, created_by)
  values (v ->> 'code', v ->> 'name', v ->> 'program', v ->> 'intake', v ->> 'intake_group',
          (v ->> 'organization_id')::integer, v ->> 'file_name_hint', (v ->> 'display_order')::smallint,
          v ->> 'description', v_cycle, 'active', (select auth.uid()))
  returning id into v_id;
  perform private.log_audit('project.create', v || jsonb_build_object('id', v_id));
  return v || jsonb_build_object('id', v_id);
end;
$$;

create or replace function public.update_project(p_code text, p_project jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.projects%rowtype;
  v jsonb;
begin
  perform private.require_permission('projects.manage');
  select * into v_old from public.projects where code = p_code and status <> 'draft' for update;
  if v_old.id is null then
    raise exception 'Unknown project %', p_code using errcode = '22023';
  end if;
  v := private.validate_project_spec(p_project || jsonb_build_object('code', v_old.code,
         'display_order', coalesce(nullif(p_project ->> 'display_order', ''), v_old.display_order::text)));
  if (v ->> 'organization_id')::integer <> v_old.organization_id then
    if exists (select 1 from public.tickets t where t.project_id = v_old.id) then
      raise exception 'The Organization ID cannot change once tickets are imported (each ticket stores the source Organization_ID).'
        using errcode = '22023';
    end if;
    if v_old.status = 'active' then
      perform private.assert_org_available((v ->> 'organization_id')::integer, array[v_old.id]);
    end if;
  end if;
  update public.projects
     set name = v ->> 'name', program = v ->> 'program', intake = v ->> 'intake',
         intake_group = v ->> 'intake_group', organization_id = (v ->> 'organization_id')::integer,
         file_name_hint = v ->> 'file_name_hint', display_order = (v ->> 'display_order')::smallint,
         description = v ->> 'description'
   where id = v_old.id;
  perform private.log_audit('project.update', jsonb_build_object('code', p_code, 'before', jsonb_build_object(
    'name', v_old.name, 'program', v_old.program, 'intake', v_old.intake, 'organization_id', v_old.organization_id),
    'after', v));
  return v;
end;
$$;

create or replace function public.archive_project(p_code text, p_reason text, p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.projects%rowtype;
begin
  perform private.require_permission('projects.manage');
  select * into v_project from public.projects where code = p_code for update;
  if v_project.id is null or v_project.status <> 'active' then
    raise exception 'Only an active project can be archived.' using errcode = '22023';
  end if;
  if coalesce(p_confirm, '') <> v_project.code then
    raise exception 'Confirmation does not match: type the project code % to archive it.', v_project.code using errcode = '22023';
  end if;
  perform private.assert_no_running_import(array[v_project.id]);
  update public.projects
     set status = 'archived', archived_at = now(), archived_by = (select auth.uid()),
         archive_reason = nullif(btrim(coalesce(p_reason, '')), ''), archived_via = 'project'
   where id = v_project.id;
  perform private.log_audit('project.archive', jsonb_build_object(
    'code', p_code, 'reason', p_reason, 'tickets', (select count(*) from public.tickets t where t.project_id = v_project.id)));
  return jsonb_build_object('code', p_code, 'status', 'archived');
end;
$$;

create or replace function public.restore_project(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.projects%rowtype;
  v_cycle_status text;
begin
  perform private.require_permission('projects.manage');
  select * into v_project from public.projects where code = p_code for update;
  if v_project.id is null or v_project.status <> 'archived' then
    raise exception 'Only an archived project can be restored.' using errcode = '22023';
  end if;
  select status into v_cycle_status from public.reporting_cycles where id = v_project.cycle_id;
  if v_cycle_status <> 'active' then
    raise exception 'Project % belongs to an archived reporting cycle. Restore the cycle instead.', p_code using errcode = '22023';
  end if;
  perform private.assert_org_available(v_project.organization_id, array[v_project.id]);
  update public.projects
     set status = 'active', archived_at = null, archived_by = null, archive_reason = null, archived_via = null
   where id = v_project.id;
  perform private.log_audit('project.restore', jsonb_build_object('code', p_code));
  return jsonb_build_object('code', p_code, 'status', 'active');
end;
$$;

create or replace function public.set_topic_category(p_topic text, p_category_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_topic text := btrim(coalesce(p_topic, ''));
  v_category smallint;
  v_old text;
  v_updated integer;
begin
  perform private.require_permission('categories.manage');
  if length(v_topic) not between 1 and 500 then
    raise exception 'Invalid topic' using errcode = '22023';
  end if;
  select k.code into v_old from public.topic_categories m join public.ticket_categories k on k.id = m.category_id where m.topic = v_topic;

  if nullif(p_category_code, '') is null then
    delete from public.topic_categories where topic = v_topic;
  else
    select id into v_category from public.ticket_categories where code = p_category_code and kind = 'category';
    if v_category is null then
      raise exception 'Unknown category %', p_category_code using errcode = '22023';
    end if;
    insert into public.topic_categories (topic, category_id, source, updated_by)
    values (v_topic, v_category, 'admin', (select auth.uid()))
    on conflict (topic) do update set category_id = excluded.category_id, source = 'admin', updated_by = excluded.updated_by;
  end if;

  update public.ticket_classifications c
     set category_id = private.category_id_for_topic(t.topic),
         evidence = jsonb_set(c.evidence, '{topic_mapped}', to_jsonb(nullif(p_category_code, '') is not null))
    from public.tickets t
   where c.ticket_pk = t.id and c.is_current and t.topic = v_topic;
  get diagnostics v_updated = row_count;

  perform private.log_audit('category.map_topic', jsonb_build_object(
    'topic', v_topic, 'from', v_old, 'to', nullif(p_category_code, ''), 'tickets_reclassified', v_updated));
  return jsonb_build_object('topic', v_topic, 'category', nullif(p_category_code, ''), 'tickets_reclassified', v_updated);
end;
$$;

create or replace function public.upsert_category(p_code text, p_name_en text, p_name_ar text default null::text, p_description text default null::text, p_is_active boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := lower(btrim(coalesce(p_code, '')));
  v_existing public.ticket_categories%rowtype;
begin
  perform private.require_permission('categories.manage');
  if v_code !~ '^[a-z][a-z0-9_]{1,59}$' then
    raise exception 'Category code must use 2–60 lowercase letters, digits or underscores (e.g. certificates_requests).' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_name_en, ''))) not between 1 and 120 then
    raise exception 'English name is required (max 120 characters).' using errcode = '22023';
  end if;
  select * into v_existing from public.ticket_categories where code = v_code;
  if v_existing.id is not null and v_existing.kind <> 'category' then
    raise exception 'Issue themes are maintained by the classification rules and cannot be edited here.' using errcode = '22023';
  end if;
  if v_existing.code = 'uncategorized' and p_is_active is false then
    raise exception 'The fallback category cannot be deactivated.' using errcode = '22023';
  end if;
  if v_existing.id is not null and p_is_active is false
     and exists (select 1 from public.topic_categories m where m.category_id = v_existing.id) then
    raise exception 'Re-map the topics of this category before deactivating it.' using errcode = '22023';
  end if;
  insert into public.ticket_categories (code, kind, name_en, name_ar, description, sort_order, is_active)
  values (v_code, 'category', btrim(p_name_en), nullif(btrim(coalesce(p_name_ar, '')), ''),
          nullif(btrim(coalesce(p_description, '')), ''),
          (select coalesce(max(sort_order), 0) + 1 from public.ticket_categories where kind = 'category' and code <> 'uncategorized'),
          coalesce(p_is_active, true))
  on conflict (code) do update
     set name_en = excluded.name_en, name_ar = excluded.name_ar, description = excluded.description,
         is_active = excluded.is_active;
  perform private.log_audit(case when v_existing.id is null then 'category.create' else 'category.update' end,
    jsonb_build_object('code', v_code, 'name_en', btrim(p_name_en), 'is_active', coalesce(p_is_active, true)));
  return jsonb_build_object('code', v_code);
end;
$$;

create or replace function public.set_status_class(p_status text, p_class text, p_label text default null::text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := btrim(coalesce(p_status, ''));
  v_old text;
begin
  perform private.require_permission('categories.manage');
  if p_class not in ('open', 'closed') then
    raise exception 'A status must be classified as open or closed.' using errcode = '22023';
  end if;
  if not (v_status = '__none__' or v_status ~ '^[A-Za-z][A-Za-z _-]{0,39}$') then
    raise exception 'Invalid status value' using errcode = '22023';
  end if;
  select status_class into v_old from public.ticket_statuses where status = v_status;
  insert into public.ticket_statuses (status, status_class, label, sort_order, updated_by)
  values (v_status, p_class,
          coalesce(nullif(btrim(coalesce(p_label, '')), ''), initcap(replace(v_status, '_', ' '))),
          (select coalesce(max(sort_order), 0) + 1 from public.ticket_statuses), (select auth.uid()))
  on conflict (status) do update
     set status_class = excluded.status_class,
         label = coalesce(nullif(btrim(coalesce(p_label, '')), ''), public.ticket_statuses.label),
         updated_by = excluded.updated_by;
  perform private.log_audit('status.classify', jsonb_build_object('status', v_status, 'from', v_old, 'to', p_class));
  return jsonb_build_object('status', v_status, 'class', p_class);
end;
$$;

create or replace function public.create_import_job(p_spec jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mode text := p_spec ->> 'mode';
  v_filename text := btrim(coalesce(p_spec ->> 'filename', ''));
  v_size bigint := nullif(p_spec ->> 'size_bytes', '')::bigint;
  v_format text;
  v_project public.projects%rowtype;
  v_archive_project public.projects%rowtype;
  v_cycle public.reporting_cycles%rowtype;
  v_new_project jsonb;
  v_new_cycle jsonb;
  v_ignore uuid[];
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  perform private.require_permission('imports.manage');

  if length(v_filename) not between 1 and 255 or v_filename ~ '[/\\]' then
    raise exception 'Invalid file name.' using errcode = '22023';
  end if;
  v_format := case when lower(v_filename) like '%.csv' then 'csv' when lower(v_filename) like '%.xlsx' then 'xlsx' end;
  if v_format is null then
    raise exception 'Unsupported file type. Upload the export as .csv (UTF-8) or .xlsx.' using errcode = '22023';
  end if;
  if v_size is null or v_size <= 0 then
    raise exception 'The file is empty.' using errcode = '22023';
  end if;
  if v_size > 52428800 then
    raise exception 'The file is larger than 50 MB. Split the export into smaller files (for example by month).' using errcode = '22023';
  end if;

  if v_mode = 'upsert' then
    select * into v_project from public.projects where code = p_spec ->> 'project_code' and status <> 'draft';
    if v_project.id is null then
      raise exception 'Choose the project to import into.' using errcode = '22023';
    end if;
    if v_project.status <> 'active' then
      raise exception 'Project % is archived and read-only. Restore it first, or use "Archive & start new".', v_project.code
        using errcode = '22023';
    end if;
  elsif v_mode = 'archive_and_start' then
    v_new_project := private.validate_project_spec(p_spec -> 'new_project');
    if exists (select 1 from public.projects where code = v_new_project ->> 'code') then
      raise exception 'A project with code % already exists (codes stay reserved, including archived projects).', v_new_project ->> 'code'
        using errcode = '22023';
    end if;
    if p_spec ->> 'archive_scope' = 'project' then
      select * into v_archive_project from public.projects where code = p_spec ->> 'archive_project_code';
      if v_archive_project.id is null or v_archive_project.status <> 'active' then
        raise exception 'Choose an active project to archive.' using errcode = '22023';
      end if;
      v_ignore := array[v_archive_project.id];
      perform private.assert_no_running_import(v_ignore);
    elsif p_spec ->> 'archive_scope' = 'cycle' then
      select * into v_cycle from public.reporting_cycles where code = p_spec ->> 'archive_cycle_code';
      if v_cycle.id is null or v_cycle.status <> 'active' then
        raise exception 'Choose an active reporting cycle to archive.' using errcode = '22023';
      end if;
      v_new_cycle := private.validate_cycle_spec(p_spec -> 'new_cycle');
      select coalesce(array_agg(id), '{}') into v_ignore from public.projects where cycle_id = v_cycle.id and status = 'active';
      perform private.assert_no_running_import(v_ignore);
    else
      raise exception 'Choose whether to archive a project or a whole reporting cycle.' using errcode = '22023';
    end if;
    perform private.assert_org_available((v_new_project ->> 'organization_id')::integer, v_ignore);
  else
    raise exception 'Unknown import mode.' using errcode = '22023';
  end if;

  v_path := v_id::text || '/source.' || v_format;
  insert into public.import_jobs (id, mode, project_id, archive_scope, archive_project_id, archive_cycle_id,
                                  new_project, new_cycle, storage_path, original_filename, file_format,
                                  declared_size_bytes, created_by)
  values (v_id, v_mode, v_project.id, nullif(p_spec ->> 'archive_scope', ''), v_archive_project.id, v_cycle.id,
          v_new_project, v_new_cycle, v_path, v_filename, v_format, v_size, (select auth.uid()));

  perform private.job_event(v_id, 'job.created', jsonb_build_object('mode', v_mode, 'filename', v_filename, 'size', v_size));
  perform private.log_audit('import.job_created', jsonb_build_object(
    'job_id', v_id, 'mode', v_mode, 'project', coalesce(v_project.code, v_new_project ->> 'code'), 'filename', v_filename));
  return jsonb_build_object('id', v_id, 'storage_path', v_path, 'bucket', 'imports', 'format', v_format);
end;
$$;

create or replace function public.mark_import_uploaded(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
  v_size bigint;
begin
  perform private.require_permission('imports.manage');
  select * into v_job from public.import_jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Unknown import job' using errcode = '22023';
  end if;
  if v_job.status <> 'awaiting_upload' then
    return jsonb_build_object('id', v_job.id, 'status', v_job.status);
  end if;
  select (o.metadata ->> 'size')::bigint into v_size
    from storage.objects o where o.bucket_id = 'imports' and o.name = v_job.storage_path;
  if v_size is null then
    raise exception 'The upload has not finished yet (no file found). Upload the file again.' using errcode = '22023';
  end if;
  update public.import_jobs
     set status = 'uploaded', file_size_bytes = v_size, uploaded_at = now(),
         progress_phase = 'queued', progress_done = 0, progress_total = 0
   where id = p_job_id;
  perform private.job_event(p_job_id, 'job.uploaded', jsonb_build_object('size', v_size));
  return jsonb_build_object('id', p_job_id, 'status', 'uploaded', 'size', v_size);
end;
$$;

create or replace function public.refresh_import_preview(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  perform private.require_permission('imports.manage');
  select status into v_status from public.import_jobs where id = p_job_id for update;
  if v_status is distinct from 'ready' then
    raise exception 'The preview can only be refreshed while the import awaits confirmation.' using errcode = '22023';
  end if;
  perform private.compute_import_preview(p_job_id);
  return (select jsonb_build_object('preview', preview, 'preview_version', preview_version) from public.import_jobs where id = p_job_id);
end;
$$;

create or replace function public.confirm_import_job(p_job_id uuid, p_policy text, p_preview_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_project_id uuid;
  v_cycle_id uuid;
  v_np jsonb;
  v_run uuid;
  v_prior uuid;
  v_rejected integer;
  v_valid integer;
begin
  perform private.require_permission('imports.manage');
  if p_policy not in ('all_or_nothing', 'import_valid_rows') then
    raise exception 'Choose how invalid rows are handled.' using errcode = '22023';
  end if;

  select * into v_job from public.import_jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Unknown import job' using errcode = '22023';
  end if;
  if v_job.status <> 'ready' then
    raise exception 'This import is not awaiting confirmation (status: %).', v_job.status using errcode = '22023';
  end if;

  -- Concurrency: lock the projects involved, and refuse while the CLI importer runs.
  if v_job.mode = 'upsert' then
    perform 1 from public.projects where id = v_job.project_id and status = 'active' for update;
    if not found then
      raise exception 'The target project is no longer active.' using errcode = '22023';
    end if;
    perform private.assert_no_running_import(array[v_job.project_id]);
  elsif v_job.archive_scope = 'project' then
    perform 1 from public.projects where id = v_job.archive_project_id and status = 'active' for update;
    if not found then
      raise exception 'The project to archive is no longer active.' using errcode = '22023';
    end if;
    perform private.assert_no_running_import(array[v_job.archive_project_id]);
  else
    perform 1 from public.reporting_cycles where id = v_job.archive_cycle_id and status = 'active' for update;
    if not found then
      raise exception 'The reporting cycle to archive is no longer active.' using errcode = '22023';
    end if;
    perform private.assert_no_running_import(
      (select coalesce(array_agg(id), '{}') from public.projects where cycle_id = v_job.archive_cycle_id and status = 'active'));
  end if;
  if exists (select 1 from public.import_runs r where r.status = 'running' and r.source = 'cli'
                                                  and r.started_at > now() - interval '2 hours') then
    raise exception 'A command-line import is running. Try again when it has finished.' using errcode = '55P03';
  end if;

  v_before := v_job.preview -> 'counts';
  if v_job.preview_version <> p_preview_version then
    v_after := null; -- a newer preview exists: the administrator must review it
  elsif v_job.preview_basis is not distinct from private.import_preview_basis(v_job.project_id) then
    v_after := v_before; -- nothing that affects the preview changed since it was computed
  else
    v_after := (private.compute_import_preview(p_job_id)) -> 'counts';
  end if;
  if v_job.preview_version <> p_preview_version or v_before is distinct from v_after then
    -- Returned (not raised) so the refreshed preview is kept for the administrator to review.
    perform private.job_event(p_job_id, 'job.preview_changed', jsonb_build_object('before', v_before, 'after', v_after));
    return jsonb_build_object('id', p_job_id, 'status', 'ready', 'preview_changed', true,
      'message', 'The data changed since this preview was computed. Review the refreshed preview and confirm again.');
  end if;

  v_rejected := (v_after ->> 'invalid')::int;
  v_valid := (v_after ->> 'valid')::int;
  if p_policy = 'all_or_nothing' and v_rejected > 0 then
    raise exception '% row(s) are invalid. Fix the file and upload it again, or choose "Import valid rows only".', v_rejected
      using errcode = '22023';
  end if;
  if v_valid = 0 then
    raise exception 'There are no valid rows to import.' using errcode = '22023';
  end if;

  -- Fresh dataset: create the draft cycle/project now (hidden until the import completes).
  if v_job.mode = 'archive_and_start' then
    v_np := v_job.new_project;
    if exists (select 1 from public.projects where code = v_np ->> 'code') then
      raise exception 'A project with code % already exists.', v_np ->> 'code' using errcode = '22023';
    end if;
    if v_job.archive_scope = 'cycle' then
      if exists (select 1 from public.reporting_cycles where code = v_job.new_cycle ->> 'code') then
        raise exception 'A reporting cycle with code % already exists.', v_job.new_cycle ->> 'code' using errcode = '22023';
      end if;
      insert into public.reporting_cycles (code, name, description, status, display_order, created_by)
      values (v_job.new_cycle ->> 'code', v_job.new_cycle ->> 'name', v_job.new_cycle ->> 'description', 'draft',
              (select coalesce(max(display_order), 0) + 1 from public.reporting_cycles), (select auth.uid()))
      returning id into v_cycle_id;
    else
      select cycle_id into v_cycle_id from public.projects where id = v_job.archive_project_id;
    end if;
    insert into public.projects (code, name, program, intake, intake_group, organization_id, file_name_hint,
                                 display_order, description, cycle_id, status, created_by)
    values (v_np ->> 'code', v_np ->> 'name', v_np ->> 'program', v_np ->> 'intake', v_np ->> 'intake_group',
            (v_np ->> 'organization_id')::integer, v_np ->> 'file_name_hint', (v_np ->> 'display_order')::smallint,
            v_np ->> 'description', v_cycle_id, 'draft', (select auth.uid()))
    returning id into v_project_id;
  else
    v_project_id := v_job.project_id;
  end if;

  select r.id into v_prior from public.import_runs r
   where r.file_hash = v_job.file_hash and r.status in ('completed', 'completed_with_errors')
   order by r.completed_at desc limit 1;

  insert into public.import_runs (source_filename, project_id, file_hash, file_size_bytes, status, records_in_file,
                                  rejected_count, data_as_of, min_created_at, max_created_at, duplicate_of_run_id,
                                  update_policy, importer_version, reconciliation, source, triggered_by, invalid_row_policy)
  values (v_job.original_filename, v_project_id, v_job.file_hash, v_job.file_size_bytes, 'running', v_job.rows_total,
          v_rejected, v_job.data_as_of, v_job.min_created_at, v_job.max_created_at, v_prior,
          'newer-or-equal-export-wins:v1', 'web-1.0.0',
          coalesce(v_job.validation_summary -> 'stats', '{}'::jsonb) || jsonb_build_object('job_id', v_job.id, 'format', v_job.file_format),
          'web', (select auth.uid()), p_policy)
  returning id into v_run;

  -- Rejected rows are recorded with their reasons — never silently discarded.
  insert into public.import_errors (import_run_id, source_row_number, ticket_id, error_code, validation_error, raw_row)
  select v_run, r.row_number, r.ticket_id, coalesce(r.error_code, 'VALIDATION_FAILED'),
         case when r.line is not null then format('line %s: %s', r.line, coalesce(r.error_message, 'invalid row'))
              else coalesce(r.error_message, 'invalid row') end,
         r.raw
    from public.import_job_rows r
   where r.job_id = p_job_id and not r.is_valid;

  update public.import_jobs
     set status = 'importing', project_id = v_project_id, new_cycle_id = v_cycle_id, import_run_id = v_run,
         invalid_row_policy = p_policy, rows_to_apply = v_valid, rows_applied = 0,
         confirmed_by = (select auth.uid()), confirmed_at = now(), attempts = 0, error_code = null, last_error = null,
         lease_owner = null, lease_expires_at = null, progress_phase = 'importing', progress_done = 0, progress_total = v_valid
   where id = p_job_id;

  perform private.job_event(p_job_id, 'job.confirmed', jsonb_build_object('policy', p_policy, 'counts', v_after, 'run_id', v_run));
  perform private.log_audit('import.confirmed', jsonb_build_object(
    'job_id', p_job_id, 'run_id', v_run, 'policy', p_policy, 'counts', v_after, 'mode', v_job.mode));
  return jsonb_build_object('id', p_job_id, 'status', 'importing', 'run_id', v_run, 'rows_to_apply', v_valid);
exception
  when unique_violation then
    raise exception 'Another import for this project started at the same time. Wait for it to finish and try again.'
      using errcode = '55P03';
end;
$$;

create or replace function public.cancel_import_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
  v_discarded integer := 0;
begin
  perform private.require_permission('imports.manage');
  select * into v_job from public.import_jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Unknown import job' using errcode = '22023';
  end if;
  if v_job.status in ('completed', 'completed_with_errors', 'cancelled') then
    raise exception 'This import has already finished.' using errcode = '22023';
  end if;
  if v_job.status = 'importing' then
    raise exception 'The import is running. Wait for it to finish; if it fails you can retry or cancel it then.' using errcode = '22023';
  end if;

  v_discarded := private.discard_job_drafts(v_job);
  if v_job.import_run_id is not null then
    update public.import_runs
       set status = 'failed', completed_at = coalesce(completed_at, now()),
           error_summary = coalesce(error_summary, format('Cancelled by an administrator after %s of %s rows were applied.',
                                                          v_job.rows_applied, coalesce(v_job.rows_to_apply, 0)))
     where id = v_job.import_run_id and status in ('running', 'failed');
  end if;
  update public.import_jobs
     set status = 'cancelled', cancelled_by = (select auth.uid()), cancelled_at = now(),
         lease_owner = null, lease_expires_at = null
   where id = p_job_id;
  delete from public.import_job_rows where job_id = p_job_id;

  perform private.job_event(p_job_id, 'job.cancelled', jsonb_build_object(
    'previous_status', v_job.status, 'rows_applied', v_job.rows_applied, 'draft_tickets_discarded', v_discarded));
  perform private.log_audit('import.cancelled', jsonb_build_object(
    'job_id', p_job_id, 'previous_status', v_job.status, 'rows_applied', v_job.rows_applied, 'draft_tickets_discarded', v_discarded));
  return jsonb_build_object('id', p_job_id, 'status', 'cancelled', 'rows_applied', v_job.rows_applied,
                            'draft_tickets_discarded', v_discarded);
end;
$$;

create or replace function public.retry_import_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
  v_next text;
begin
  perform private.require_permission('imports.manage');
  select * into v_job from public.import_jobs where id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'failed' then
    raise exception 'Only a failed import can be retried.' using errcode = '22023';
  end if;
  if v_job.import_run_id is null then
    if v_job.uploaded_at is null then
      raise exception 'The file was never uploaded. Start a new import.' using errcode = '22023';
    end if;
    delete from public.import_job_rows where job_id = p_job_id;
    delete from public.import_job_issues where job_id = p_job_id;
    v_next := 'uploaded';
    update public.import_jobs
       set status = 'uploaded', rows_staged = 0, rows_total = null, preview = null, attempts = 0,
           error_code = null, last_error = null, lease_owner = null, lease_expires_at = null,
           progress_phase = 'queued', progress_done = 0, progress_total = 0
     where id = p_job_id;
  else
    v_next := 'importing';
    update public.import_runs set status = 'running', completed_at = null, error_summary = null
     where id = v_job.import_run_id and status = 'failed';
    update public.import_jobs
       set status = 'importing', attempts = 0, error_code = null, last_error = null,
           lease_owner = null, lease_expires_at = null, progress_phase = 'importing'
     where id = p_job_id;
  end if;
  perform private.job_event(p_job_id, 'job.retried', jsonb_build_object('resume_as', v_next));
  perform private.log_audit('import.retried', jsonb_build_object('job_id', p_job_id, 'resume_as', v_next));
  return jsonb_build_object('id', p_job_id, 'status', v_next);
exception
  when unique_violation then
    raise exception 'Another import is running for this project. Retry when it has finished.' using errcode = '55P03';
end;
$$;

create or replace function public.get_import_jobs(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('imports.manage');
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
    from (
      select j.id, j.mode, j.status, j.original_filename, j.file_format, j.file_size_bytes, j.created_at,
        j.confirmed_at, j.completed_at, j.rows_total, j.rows_valid, j.rows_invalid, j.warnings_count,
        j.rows_applied, j.rows_to_apply, j.rows_staged, j.progress_phase, j.error_code, j.last_error,
        j.import_run_id, j.archive_scope, j.new_project ->> 'code' as new_project_code,
        coalesce(p.code, j.new_project ->> 'code') as project, coalesce(p.name, j.new_project ->> 'name') as project_name,
        ap.code as archive_project, ac.code as archive_cycle,
        u.email::text as created_by_email,
        (j.status in ('uploaded', 'validating', 'importing') and j.lease_expires_at < now() - interval '2 minutes') as stalled
      from public.import_jobs j
      left join public.projects p on p.id = j.project_id
      left join public.projects ap on ap.id = j.archive_project_id
      left join public.reporting_cycles ac on ac.id = j.archive_cycle_id
      left join auth.users u on u.id = j.created_by
      order by j.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) x), '[]'::jsonb);
end;
$$;

create or replace function public.get_import_job(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.require_permission('imports.manage');
  select jsonb_build_object(
    'job', to_jsonb(j) - 'lease_owner',
    'project', case when p.id is null then null else jsonb_build_object(
      'code', p.code, 'name', p.name, 'status', p.status, 'organization_id', p.organization_id) end,
    'archive_project', case when ap.id is null then null else jsonb_build_object('code', ap.code, 'name', ap.name, 'status', ap.status) end,
    'archive_cycle', case when ac.id is null then null else jsonb_build_object('code', ac.code, 'name', ac.name, 'status', ac.status) end,
    'run', case when r.id is null then null else jsonb_build_object(
      'id', r.id, 'status', r.status, 'inserted_count', r.inserted_count, 'updated_count', r.updated_count,
      'skipped_unchanged_count', r.skipped_unchanged_count, 'skipped_stale_count', r.skipped_stale_count,
      'rejected_count', r.rejected_count, 'records_in_file', r.records_in_file,
      'completed_at', r.completed_at, 'error_summary', r.error_summary) end,
    'issue_counts', coalesce((
      select jsonb_agg(jsonb_build_object('severity', i.severity, 'code', i.code, 'count', i.n) order by i.severity, i.n desc)
      from (select severity, code, count(*) n from public.import_job_issues where job_id = j.id group by 1, 2) i), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('at', e.occurred_at, 'event', e.event, 'details', e.details, 'email', u.email::text)
                       order by e.occurred_at, e.id)
      from public.import_job_events e left join auth.users u on u.id = e.actor where e.job_id = j.id), '[]'::jsonb),
    'created_by_email', (select u.email::text from auth.users u where u.id = j.created_by),
    'confirmed_by_email', (select u.email::text from auth.users u where u.id = j.confirmed_by),
    'stalled', (j.status in ('uploaded', 'validating', 'importing') and j.lease_expires_at < now() - interval '2 minutes'),
    'now', now()
  ) into v
  from public.import_jobs j
  left join public.projects p on p.id = j.project_id
  left join public.projects ap on ap.id = j.archive_project_id
  left join public.reporting_cycles ac on ac.id = j.archive_cycle_id
  left join public.import_runs r on r.id = j.import_run_id
  where j.id = p_job_id;
  return v;
end;
$$;

create or replace function public.get_import_job_issues(p_job_id uuid, p_severity text default null::text, p_limit integer default 200, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('imports.manage');
  return jsonb_build_object(
    'total', (select count(*) from public.import_job_issues i
               where i.job_id = p_job_id and (p_severity is null or i.severity = p_severity)),
    'issues', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.ord)
      from (
        select row_number() over (order by case i.severity when 'error' then 0 when 'warning' then 1 else 2 end,
                                           i.row_number nulls first, i.code, i.id) as ord,
          i.severity, i.code, i.row_number, i.line, i.ticket_id, i.column_name, i.message, i.value_excerpt
        from public.import_job_issues i
        where i.job_id = p_job_id and (p_severity is null or i.severity = p_severity)
        order by 1
        limit least(greatest(coalesce(p_limit, 200), 1), 5000) offset greatest(coalesce(p_offset, 0), 0)
      ) x), '[]'::jsonb));
end;
$$;

create or replace function public.get_audit_events(p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.require_permission('audit.view');
  select coalesce(jsonb_agg(to_jsonb(x) order by x.occurred_at desc), '[]'::jsonb)
    into v
  from (
    select a.id, a.occurred_at, a.action, a.details, u.email::text as email
    from public.audit_events a
    left join auth.users u on u.id = a.user_id
    order by a.occurred_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
  ) x;
  return v;
end;
$$;

-- Ticket-row exports need export.tickets (+ tickets.read_content with message
-- text); every other export kind is aggregated data and needs export.aggregate.
create or replace function public.record_export(p_kind text, p_filters jsonb, p_row_count integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_kind like 'tickets%' then
    perform private.require_permission('export.tickets');
    if p_kind like '%text%' then
      perform private.require_permission('tickets.read_content');
    end if;
  else
    perform private.require_permission('export.aggregate');
  end if;
  if p_kind !~ '^[a-z][a-z0-9_]{1,60}$' then
    raise exception 'Invalid export kind' using errcode = '22023';
  end if;
  perform private.log_audit('export.' || p_kind,
    jsonb_build_object('filters', coalesce(p_filters, '{}'::jsonb), 'rows', p_row_count));
end;
$$;

-- =============================================================================
-- Access context and access management
-- =============================================================================

-- The caller's role, effective permissions and project scope.
create or replace function public.get_my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', me.uid,
    'role', ur.role,
    'role_name', r.name,
    'permissions', to_jsonb(coalesce(private.current_permissions(), '{}'::text[])),
    'all_projects', coalesce(ur.all_projects, false),
    'programs', coalesce((
      select jsonb_agg(g.program order by g.program)
      from public.user_program_access g where g.user_id = me.uid), '[]'::jsonb),
    'project_codes', coalesce((
      select jsonb_agg(p.code order by p.code)
      from public.user_project_access a join public.projects p on p.id = a.project_id
      where a.user_id = me.uid), '[]'::jsonb))
  from (select (select auth.uid()) as uid) me
  left join public.user_roles ur on ur.user_id = me.uid
  left join public.app_roles r on r.code = ur.role;
$$;

create or replace function public.list_app_users()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.require_role('admin');
  select coalesce(jsonb_agg(to_jsonb(x) order by x.role nulls last, x.email), '[]'::jsonb)
    into v
  from (
    select u.id as user_id, u.email::text as email, ur.role, r.name as role_name,
      coalesce(ur.all_projects, true) as all_projects,
      coalesce((select jsonb_agg(g.program order by g.program)
                from public.user_program_access g where g.user_id = u.id), '[]'::jsonb) as programs,
      coalesce((select jsonb_agg(p.code order by p.code)
                from public.user_project_access a join public.projects p on p.id = a.project_id
                where a.user_id = u.id), '[]'::jsonb) as project_codes,
      u.created_at, u.last_sign_in_at, u.email_confirmed_at, u.invited_at
    from auth.users u
    left join public.user_roles ur on ur.user_id = u.id
    left join public.app_roles r on r.code = ur.role
    where u.deleted_at is null
  ) x;
  return v;
end;
$$;

create or replace function public.list_app_roles()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role('admin');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', r.code, 'name', r.name, 'description', r.description,
      'permissions', to_jsonb(case when r.code = 'admin' then private.permission_catalog() else r.permissions end),
      'is_system', r.is_system, 'editable', r.code <> 'admin',
      'users', (select count(*) from public.user_roles ur where ur.role = r.code),
      'updated_at', r.updated_at)
      order by (r.code <> 'admin'), (r.code <> 'analyst'), lower(r.name))
    from public.app_roles r), '[]'::jsonb);
end;
$$;

-- Creates (p_is_new) or updates a role. Unknown permission keys are rejected;
-- the stored list is de-duplicated and kept in catalog order.
create or replace function public.upsert_app_role(
  p_code text,
  p_name text,
  p_description text,
  p_permissions text[],
  p_is_new boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text := lower(btrim(coalesce(p_code, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_unknown text[];
  v_perms text[];
  v_exists boolean;
begin
  perform private.require_role('admin');
  if v_code = 'admin' then
    raise exception 'The Administrator role always has every permission and cannot be changed.' using errcode = '22023';
  end if;
  if v_code !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'Role code: 2–40 lowercase letters, digits or underscores, starting with a letter.' using errcode = '22023';
  end if;
  if length(v_name) not between 1 and 60 then
    raise exception 'Role name: 1–60 characters.' using errcode = '22023';
  end if;
  if length(coalesce(p_description, '')) > 500 then
    raise exception 'Description: at most 500 characters.' using errcode = '22023';
  end if;

  v_exists := exists (select 1 from public.app_roles r where r.code = v_code);
  if p_is_new and v_exists then
    raise exception 'A role with the code "%" already exists.', v_code using errcode = '23505';
  end if;
  if not p_is_new and not v_exists then
    raise exception 'No role with the code "%".', v_code using errcode = '22023';
  end if;
  if exists (select 1 from public.app_roles r where lower(btrim(r.name)) = lower(v_name) and r.code <> v_code) then
    raise exception 'Another role is already named "%".', v_name using errcode = '23505';
  end if;

  select array_agg(distinct x order by x) into v_unknown
  from unnest(coalesce(p_permissions, '{}'::text[])) x
  where not (x = any (private.permission_catalog()));
  if v_unknown is not null then
    raise exception 'Unknown permission(s): %', array_to_string(v_unknown, ', ') using errcode = '22023';
  end if;
  v_perms := array(
    select k from unnest(private.permission_catalog()) with ordinality as c(k, i)
    where k = any (coalesce(p_permissions, '{}'::text[]))
    order by i);

  insert into public.app_roles (code, name, description, permissions, created_by)
  values (v_code, v_name, nullif(btrim(coalesce(p_description, '')), ''), v_perms, (select auth.uid()))
  on conflict (code) do update
    set name = excluded.name, description = excluded.description, permissions = excluded.permissions;

  perform private.log_audit(case when v_exists then 'access.role_updated' else 'access.role_created' end,
    jsonb_build_object('role', v_code, 'name', v_name, 'permissions', to_jsonb(v_perms)));
  return jsonb_build_object('code', v_code, 'name', v_name, 'permissions', to_jsonb(v_perms));
end;
$$;

create or replace function public.delete_app_role(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role public.app_roles;
  v_users integer;
begin
  perform private.require_role('admin');
  select * into v_role from public.app_roles r where r.code = p_code;
  if v_role.code is null then
    raise exception 'No role with the code "%".', p_code using errcode = '22023';
  end if;
  if v_role.is_system then
    raise exception 'The % role is built in and cannot be deleted.', v_role.name using errcode = '22023';
  end if;
  select count(*) into v_users from public.user_roles ur where ur.role = p_code;
  if v_users > 0 then
    raise exception '% account(s) still have the % role. Give them another role first.', v_users, v_role.name
      using errcode = '23503';
  end if;
  delete from public.app_roles r where r.code = p_code;
  perform private.log_audit('access.role_deleted', jsonb_build_object('role', p_code, 'name', v_role.name));
  return jsonb_build_object('code', p_code, 'deleted', true);
end;
$$;

-- Grants (or changes) an account's role and project scope in one step.
-- p_all_projects = false limits the account to p_programs (including future
-- projects of those programs) plus p_project_codes.
create or replace function public.set_user_access(
  p_email text,
  p_role text,
  p_all_projects boolean default true,
  p_programs text[] default '{}',
  p_project_codes text[] default '{}'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_all boolean := coalesce(p_all_projects, true);
  v_programs text[] := '{}';
  v_projects uuid[] := '{}';
  v_codes text[] := '{}';
  v_unknown text[];
begin
  perform private.require_role('admin');
  if not exists (select 1 from public.app_roles r where r.code = p_role) then
    raise exception 'Invalid role' using errcode = '22023';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email)) and u.deleted_at is null;
  if v_user is null then
    raise exception 'No user with that email exists. Invite the user first.' using errcode = '22023';
  end if;
  if v_user = (select auth.uid()) and p_role <> 'admin' then
    raise exception 'You cannot remove your own administrator role.' using errcode = '22023';
  end if;
  if p_role = 'admin' and not v_all then
    raise exception 'Administrators always have access to all projects.' using errcode = '22023';
  end if;

  if not v_all then
    v_programs := array(
      select distinct upper(btrim(x)) from unnest(coalesce(p_programs, '{}'::text[])) x
      where btrim(x) <> '' order by 1);
    select array_agg(x order by x) into v_unknown
    from unnest(v_programs) x
    where not exists (select 1 from public.projects p where p.program = x);
    if v_unknown is not null then
      raise exception 'Unknown program(s): %', array_to_string(v_unknown, ', ') using errcode = '22023';
    end if;

    v_codes := array(
      select distinct upper(btrim(x)) from unnest(coalesce(p_project_codes, '{}'::text[])) x
      where btrim(x) <> '' order by 1);
    select array_agg(x order by x) into v_unknown
    from unnest(v_codes) x
    where not exists (select 1 from public.projects p where p.code = x);
    if v_unknown is not null then
      raise exception 'Unknown project(s): %', array_to_string(v_unknown, ', ') using errcode = '22023';
    end if;
    v_projects := array(select p.id from public.projects p where p.code = any (v_codes));

    if cardinality(v_programs) = 0 and cardinality(v_projects) = 0 then
      raise exception 'Choose at least one program or project, or give access to all projects.' using errcode = '22023';
    end if;
  end if;

  insert into public.user_roles (user_id, role, granted_by, all_projects)
  values (v_user, p_role, (select auth.uid()), v_all)
  on conflict (user_id) do update
    set role = excluded.role, granted_by = excluded.granted_by, all_projects = excluded.all_projects;

  delete from public.user_program_access g where g.user_id = v_user;
  delete from public.user_project_access a where a.user_id = v_user;
  insert into public.user_program_access (user_id, program, granted_by)
  select v_user, x, (select auth.uid()) from unnest(v_programs) x;
  insert into public.user_project_access (user_id, project_id, granted_by)
  select v_user, x, (select auth.uid()) from unnest(v_projects) x;

  perform private.log_audit('access.granted', jsonb_build_object(
    'user_id', v_user, 'role', p_role, 'all_projects', v_all,
    'programs', to_jsonb(v_programs), 'projects', to_jsonb(v_codes)));
  return jsonb_build_object('user_id', v_user, 'role', p_role, 'all_projects', v_all,
    'programs', to_jsonb(v_programs), 'project_codes', to_jsonb(v_codes));
end;
$$;

-- Role only (command line and older callers): keeps the account's project scope,
-- except that administrators always get every project.
create or replace function public.set_user_role(p_email text, p_role text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  perform private.require_role('admin');
  if not exists (select 1 from public.app_roles r where r.code = p_role) then
    raise exception 'Invalid role' using errcode = '22023';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email)) and u.deleted_at is null;
  if v_user is null then
    raise exception 'No user with that email exists. Invite the user first.' using errcode = '22023';
  end if;
  insert into public.user_roles (user_id, role, granted_by)
  values (v_user, p_role, (select auth.uid()))
  on conflict (user_id) do update
    set role = excluded.role, granted_by = excluded.granted_by,
        all_projects = public.user_roles.all_projects or excluded.role = 'admin';
  if p_role = 'admin' then
    delete from public.user_program_access g where g.user_id = v_user;
    delete from public.user_project_access a where a.user_id = v_user;
  end if;
  perform private.log_audit('access.role_granted', jsonb_build_object('user_id', v_user, 'role', p_role));
  return jsonb_build_object('user_id', v_user, 'role', p_role);
end;
$$;

-- -----------------------------------------------------------------------------
-- Function privileges: authenticated only; never anon/public.
-- -----------------------------------------------------------------------------
revoke all on function
  public.list_app_roles(),
  public.upsert_app_role(text, text, text, text[], boolean),
  public.delete_app_role(text),
  public.set_user_access(text, text, boolean, text[], text[])
from public, anon;

grant execute on function
  public.list_app_roles(),
  public.upsert_app_role(text, text, text, text[], boolean),
  public.delete_app_role(text),
  public.set_user_access(text, text, boolean, text[], text[])
to authenticated;

revoke all on all functions in schema private from public, anon;

-- Helpers used inside RLS policies must stay executable by authenticated.
grant execute on function
  private.permission_catalog(),
  private.global_permissions(),
  private.current_permissions(),
  private.has_permission(text),
  private.require_permission(text),
  private.sees_all_projects(),
  private.visible_project_ids(),
  private.current_app_role(),
  private.has_app_access(),
  private.is_admin(),
  private.require_role(text)
to authenticated;
