-- =============================================================================
-- CS Tickets Analytics — access control
--
-- Model:
--   * No anonymous access to anything.
--   * Authenticated users have NO access unless they hold a row in user_roles.
--   * 'admin'   : full analytics, raw ticket content, exports, settings, access mgmt.
--   * 'analyst' : aggregated analytics and ticket metadata only. Enforced here,
--                 in PostgreSQL, not just by hiding UI controls.
--   * Imports run server-side with a privileged database connection (CLI only).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Role helpers (private schema, not callable through the Data API)
-- -----------------------------------------------------------------------------
create or replace function private.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ur.role
  from public.user_roles ur
  where ur.user_id = (select auth.uid());
$$;

create or replace function private.has_app_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.current_app_role() in ('admin', 'analyst'), false);
$$;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.current_app_role() = 'admin', false);
$$;

-- Raises insufficient_privilege unless the caller holds at least p_min_role.
create or replace function private.require_role(p_min_role text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := private.current_app_role();
begin
  if p_min_role not in ('analyst', 'admin') then
    raise exception 'Unknown role requirement %', p_min_role;
  end if;
  if v_role is null then
    raise exception 'Access denied: no application role assigned'
      using errcode = '42501';
  end if;
  if p_min_role = 'admin' and v_role <> 'admin' then
    raise exception 'Access denied: administrator role required'
      using errcode = '42501';
  end if;
  return v_role;
end;
$$;

revoke all on all functions in schema private from public, anon;
grant execute on function private.current_app_role() to authenticated;
grant execute on function private.has_app_access() to authenticated;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.require_role(text) to authenticated;

-- Keep at least one administrator so the application cannot be locked out.
create or replace function private.user_roles_keep_one_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'DELETE' and old.role = 'admin')
     or (tg_op = 'UPDATE' and old.role = 'admin' and new.role <> 'admin') then
    if not exists (
      select 1 from public.user_roles
      where role = 'admin' and user_id <> old.user_id
    ) then
      raise exception 'Cannot remove the last administrator' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger user_roles_keep_one_admin
before update or delete on public.user_roles
for each row execute function private.user_roles_keep_one_admin();

-- -----------------------------------------------------------------------------
-- Baseline: remove the platform's default broad grants, then grant narrowly.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from public, anon;

-- Enable RLS on every table.
alter table public.projects enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_attachments enable row level security;
alter table public.import_runs enable row level security;
alter table public.import_errors enable row level security;
alter table public.ticket_categories enable row level security;
alter table public.ticket_classifications enable row level security;
alter table public.analytics_thresholds enable row level security;
alter table public.app_settings enable row level security;
alter table public.user_roles enable row level security;
alter table public.audit_events enable row level security;

-- -----------------------------------------------------------------------------
-- Read access
-- -----------------------------------------------------------------------------
grant select on public.projects to authenticated;
create policy projects_select on public.projects
  for select to authenticated using ((select private.has_app_access()));

-- Tickets: column-level grant excludes free text written by students/agents and
-- raw attachment URLs. Those are only reachable through admin-checked functions.
grant select (
  ticket_id, project_id, organization_id, topic, status, priority, department,
  owner_type, owner_id, affected_student_id, created_at, responded_at, resolved_at,
  responder_name, resolved_by, sub_topic, session_ref, lesson_name, message_language,
  parser_version, response_kind, response_seconds, resolution_seconds, created_date,
  created_hour, created_isodow, source_filename, source_row_number, source_data_as_of,
  row_hash, first_import_run_id, last_import_run_id, imported_at, updated_at
) on public.tickets to authenticated;
create policy tickets_select on public.tickets
  for select to authenticated using ((select private.has_app_access()));

grant select on public.ticket_attachments to authenticated;
create policy ticket_attachments_select on public.ticket_attachments
  for select to authenticated using ((select private.is_admin()));

grant select on public.import_runs to authenticated;
create policy import_runs_select on public.import_runs
  for select to authenticated using ((select private.has_app_access()));

grant select on public.import_errors to authenticated;
create policy import_errors_select on public.import_errors
  for select to authenticated using ((select private.is_admin()));

grant select on public.ticket_categories to authenticated;
create policy ticket_categories_select on public.ticket_categories
  for select to authenticated using ((select private.has_app_access()));

grant select on public.ticket_classifications to authenticated;
create policy ticket_classifications_select on public.ticket_classifications
  for select to authenticated using ((select private.has_app_access()));

grant select on public.analytics_thresholds to authenticated;
create policy analytics_thresholds_select on public.analytics_thresholds
  for select to authenticated using ((select private.has_app_access()));

grant select on public.app_settings to authenticated;
create policy app_settings_select on public.app_settings
  for select to authenticated using ((select private.has_app_access()));

grant select on public.user_roles to authenticated;
create policy user_roles_select on public.user_roles
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

grant select on public.audit_events to authenticated;
create policy audit_events_select on public.audit_events
  for select to authenticated using ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- Write access (admin only; tickets/imports are written by the CLI importer
-- through a privileged connection and have no client write policies at all).
-- -----------------------------------------------------------------------------
grant update (name, display_order, is_active, file_name_hint) on public.projects to authenticated;
create policy projects_update on public.projects
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

grant update (value_hours, updated_by) on public.analytics_thresholds to authenticated;
create policy analytics_thresholds_update on public.analytics_thresholds
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

grant insert, update on public.app_settings to authenticated;
create policy app_settings_insert on public.app_settings
  for insert to authenticated with check ((select private.is_admin()));
create policy app_settings_update on public.app_settings
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

grant insert, update, delete on public.user_roles to authenticated;
create policy user_roles_insert on public.user_roles
  for insert to authenticated with check ((select private.is_admin()));
create policy user_roles_update on public.user_roles
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy user_roles_delete on public.user_roles
  for delete to authenticated using ((select private.is_admin()));

grant update (name_en, name_ar, description, is_active, sort_order) on public.ticket_categories to authenticated;
create policy ticket_categories_update on public.ticket_categories
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- Audit events are only ever written by security-definer functions.

-- -----------------------------------------------------------------------------
-- Audit helper
-- -----------------------------------------------------------------------------
create or replace function private.log_audit(p_action text, p_details jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_events (user_id, action, details)
  values ((select auth.uid()), p_action, coalesce(p_details, '{}'::jsonb));
$$;

revoke all on function private.log_audit(text, jsonb) from public, anon, authenticated;
