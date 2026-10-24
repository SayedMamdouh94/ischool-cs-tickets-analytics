-- =============================================================================
-- CS Tickets Analytics — administration (projects, cycles, categories, statuses,
-- insight rules) and the web import pipeline.
--
-- Import job lifecycle (import_jobs.status):
--   awaiting_upload → uploaded → validating → ready → importing → completed | completed_with_errors
--   (any non-terminal state) → failed | cancelled ;  failed → (retry) → uploaded | importing
--
--   * The browser uploads the file straight to the private "imports" bucket with
--     a short-lived signed URL; files never pass through a web request body.
--   * The server-side worker (service role) parses and validates the file and
--     stages rows here. Validation is resumable (rows are staged idempotently).
--   * After an administrator confirms, rows are applied in small atomic batches
--     by whichever driver holds the lease: the web worker, or pg_cron every
--     15 seconds (no HTTP needed). Leases expire, so a stopped worker never
--     strands a job; repeated failures without progress mark the job failed.
-- =============================================================================

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Worker functions are executable by the service role only (grants below); this
-- check repeats that rule inside the function.
create or replace function private.require_service_role()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Access denied: service role required' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.job_event(p_job_id uuid, p_event text, p_details jsonb default '{}'::jsonb, p_actor uuid default null)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.import_job_events (job_id, actor, event, details)
  values (p_job_id, coalesce(p_actor, (select auth.uid())), p_event, coalesce(p_details, '{}'::jsonb));
$$;

-- Normalizes and validates a project definition. Raises 22023 with a readable message.
create or replace function private.validate_project_spec(p jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_code text := upper(btrim(coalesce(p ->> 'code', '')));
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_program text := upper(btrim(coalesce(p ->> 'program', '')));
  v_intake text := btrim(coalesce(p ->> 'intake', ''));
  v_group text := nullif(btrim(coalesce(p ->> 'intake_group', '')), '');
  v_org_text text := btrim(coalesce(p ->> 'organization_id', ''));
  v_description text := nullif(btrim(coalesce(p ->> 'description', '')), '');
  v_hint text := nullif(btrim(coalesce(p ->> 'file_name_hint', '')), '');
begin
  if v_code !~ '^[A-Z][A-Z0-9_]{1,39}$' then
    raise exception 'Project code must start with a letter and use 2–40 capital letters, digits or underscores (e.g. DECI_5TH).' using errcode = '22023';
  end if;
  if length(v_name) not between 1 and 120 then
    raise exception 'Project name is required (max 120 characters).' using errcode = '22023';
  end if;
  if v_program !~ '^[A-Z][A-Z0-9]{1,19}$' then
    raise exception 'Program must be 2–20 capital letters or digits (e.g. DECI, DEMI).' using errcode = '22023';
  end if;
  if length(v_intake) not between 1 and 60 then
    raise exception 'Intake is required (max 60 characters).' using errcode = '22023';
  end if;
  if v_org_text !~ '^[1-9][0-9]{0,8}$' then
    raise exception 'Organization ID must be a positive whole number (the Organization_ID used in the exports).' using errcode = '22023';
  end if;
  if v_description is not null and length(v_description) > 1000 then
    raise exception 'Description is too long (max 1,000 characters).' using errcode = '22023';
  end if;
  if v_group is not null and length(v_group) > 40 then
    raise exception 'Intake group is too long (max 40 characters).' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'code', v_code, 'name', v_name, 'program', v_program, 'intake', v_intake,
    'intake_group', coalesce(v_group, case when v_intake ilike '%summer%' then 'Summer' else 'Regular' end),
    'organization_id', v_org_text::integer, 'description', v_description,
    'file_name_hint', left(coalesce(v_hint, v_name), 120),
    'display_order', coalesce(nullif(p ->> 'display_order', '')::smallint,
                              (select coalesce(max(x.display_order), 0) + 1 from public.projects x)));
end;
$$;

create or replace function private.validate_cycle_spec(p jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_code text := upper(btrim(coalesce(p ->> 'code', '')));
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_description text := nullif(btrim(coalesce(p ->> 'description', '')), '');
begin
  if v_code !~ '^[A-Z][A-Z0-9_]{1,39}$' then
    raise exception 'Cycle code must start with a letter and use 2–40 capital letters, digits or underscores (e.g. CYCLE_2027).' using errcode = '22023';
  end if;
  if length(v_name) not between 1 and 120 then
    raise exception 'Cycle name is required (max 120 characters).' using errcode = '22023';
  end if;
  if v_description is not null and length(v_description) > 1000 then
    raise exception 'Description is too long (max 1,000 characters).' using errcode = '22023';
  end if;
  if exists (select 1 from public.reporting_cycles rc where rc.code = v_code) then
    raise exception 'A reporting cycle with code % already exists.', v_code using errcode = '22023';
  end if;
  return jsonb_build_object('code', v_code, 'name', v_name, 'description', v_description);
end;
$$;

-- Raises when another ACTIVE project (outside p_ignore) already uses the Organization_ID.
create or replace function private.assert_org_available(p_org integer, p_ignore uuid[] default '{}')
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_code text;
begin
  select p.code into v_code from public.projects p
   where p.organization_id = p_org and p.status = 'active' and not (p.id = any (coalesce(p_ignore, '{}')));
  if v_code is not null then
    raise exception 'Organization ID % is already used by active project %. Archive that project first, or use "Archive & start new".', p_org, v_code
      using errcode = '22023';
  end if;
end;
$$;

-- Raises when an import is running for any of the given projects.
create or replace function private.assert_no_running_import(p_project_ids uuid[])
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_code text;
begin
  -- Running imports into these projects, or "archive & start new" imports that will archive them.
  select p.code into v_code
    from public.import_jobs j
    join public.projects p on p.id = any (p_project_ids)
   where j.status = 'importing'
     and (j.project_id = p.id or j.archive_project_id = p.id or j.archive_cycle_id = p.cycle_id)
   limit 1;
  if v_code is not null then
    raise exception 'An import is currently running for project %. Wait until it finishes (or cancel it) and try again.', v_code
      using errcode = '55P03';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Reporting cycles
-- -----------------------------------------------------------------------------
create or replace function public.create_reporting_cycle(p_cycle jsonb, p_make_current boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_id uuid;
begin
  perform private.require_role('admin');
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

create or replace function public.update_reporting_cycle(p_code text, p_name text, p_description text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_role('admin');
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
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_role('admin');
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

-- Archives a whole cycle and every active project in it. Requires the cycle code
-- typed as confirmation. Nothing is deleted.
create or replace function public.archive_cycle(p_code text, p_reason text, p_confirm text, p_new_current text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cycle public.reporting_cycles%rowtype;
  v_projects uuid[];
  v_new uuid;
begin
  perform private.require_role('admin');
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
volatile
security definer
set search_path = ''
as $$
declare
  v_cycle public.reporting_cycles%rowtype;
  v_project record;
  v_restored integer := 0;
begin
  perform private.require_role('admin');
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

-- -----------------------------------------------------------------------------
-- Projects
-- -----------------------------------------------------------------------------
create or replace function public.create_project(p_project jsonb, p_cycle text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_cycle uuid;
  v_id uuid;
begin
  perform private.require_role('admin');
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

-- Edits metadata. The code is permanent; the Organization_ID can only change
-- while the project has no tickets (tickets carry the source Organization_ID).
drop function if exists public.update_project(text, text, smallint, boolean, text);
create function public.update_project(p_code text, p_project jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old public.projects%rowtype;
  v jsonb;
begin
  perform private.require_role('admin');
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
volatile
security definer
set search_path = ''
as $$
declare
  v_project public.projects%rowtype;
begin
  perform private.require_role('admin');
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
volatile
security definer
set search_path = ''
as $$
declare
  v_project public.projects%rowtype;
  v_cycle_status text;
begin
  perform private.require_role('admin');
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

-- Import history of one project (runs from the CLI and the web).
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
  select id into v_id from public.projects where code = p_code and status <> 'draft';
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

-- -----------------------------------------------------------------------------
-- Topic → category mapping and categories
-- -----------------------------------------------------------------------------
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
        where p.status <> 'draft'
        group by t.topic
        union all
        -- Mapped topics without tickets yet (e.g. prepared in advance).
        select m2.topic, 0, 0, '{}'::text[], null
        from public.topic_categories m2
        where not exists (select 1 from public.tickets t2 where t2.topic = m2.topic)
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

-- Maps (or re-maps) a topic and updates the category of every ticket with that
-- topic immediately. Pass null as the category to remove the mapping.
create or replace function public.set_topic_category(p_topic text, p_category_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_topic text := btrim(coalesce(p_topic, ''));
  v_category smallint;
  v_old text;
  v_updated integer;
begin
  perform private.require_role('admin');
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

create or replace function public.upsert_category(
  p_code text, p_name_en text, p_name_ar text default null, p_description text default null, p_is_active boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text := lower(btrim(coalesce(p_code, '')));
  v_existing public.ticket_categories%rowtype;
begin
  perform private.require_role('admin');
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

-- -----------------------------------------------------------------------------
-- Status classes
-- -----------------------------------------------------------------------------
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
      where p.status <> 'draft'
      group by 1
      union all
      select s.status, 0 from public.ticket_statuses s
      where not exists (select 1 from public.tickets t where coalesce(t.status, '__none__') = s.status)
    ) x
    left join public.ticket_statuses st on st.status = x.status), '[]'::jsonb);
end;
$$;

create or replace function public.set_status_class(p_status text, p_class text, p_label text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text := btrim(coalesce(p_status, ''));
  v_old text;
begin
  perform private.require_role('admin');
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

-- -----------------------------------------------------------------------------
-- Insight rules
-- -----------------------------------------------------------------------------
create or replace function public.update_insight_rule(p_key text, p_value numeric)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rule public.insight_rules%rowtype;
begin
  perform private.require_role('admin');
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

-- =============================================================================
-- Import jobs — administrator functions
-- =============================================================================

-- Creates a job and reserves its private storage path. The caller (server) then
-- issues a signed upload URL for exactly that path.
create or replace function public.create_import_job(p_spec jsonb)
returns jsonb
language plpgsql
volatile
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
  perform private.require_role('admin');

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

-- Called after the browser finished uploading. The object must exist in the
-- private bucket at the job's path; its size is taken from Storage.
create or replace function public.mark_import_uploaded(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
  v_size bigint;
begin
  perform private.require_role('admin');
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

-- Classifies every valid staged row against the database and stores the preview.
create or replace function private.compute_import_preview(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
  v_target uuid;
  v_cycle uuid;
  v_counts jsonb;
  v_preview jsonb;
  v_conflicts jsonb;
  v_regressions jsonb;
  v_field_changes jsonb;
  v_absent bigint := 0;
  v_cross_archived bigint := 0;
  v_in_archived_project bigint := 0;
begin
  select * into v_job from public.import_jobs where id = p_job_id for update;

  -- Rows were just staged: refresh planner statistics, otherwise the joins below
  -- are planned for an empty table (seconds instead of milliseconds).
  analyze public.import_job_rows;

  -- Target for comparison: the project being updated (upsert). A fresh project
  -- (archive_and_start) starts empty, so every valid row is new.
  v_target := case when v_job.mode = 'upsert' then v_job.project_id end;
  v_cycle := case
    when v_job.mode = 'upsert' then (select cycle_id from public.projects where id = v_job.project_id)
    when v_job.archive_scope = 'project' then (select cycle_id from public.projects where id = v_job.archive_project_id)
    else null end;

  -- Reset previous derived findings (a preview may be recomputed).
  delete from public.import_job_issues where job_id = p_job_id and code in ('TICKET_ID_COLLISION', 'UPDATE_REGRESSION', 'STALE_EXPORT_ROW');
  update public.import_job_rows
     set is_valid = true, error_code = null, error_message = null
   where job_id = p_job_id and error_code = 'TICKET_ID_COLLISION';

  -- Same source ID already in ANOTHER active/draft project of the same cycle:
  -- the export most likely belongs to that project. Rejected per row.
  if v_cycle is not null then
    with hit as (
      select r.row_number, r.line, r.ticket_id, min(p.code) as other
      from public.import_job_rows r
      join public.tickets t on t.ticket_id = r.ticket_id
      join public.projects p on p.id = t.project_id
      where r.job_id = p_job_id and r.is_valid
        and p.cycle_id = v_cycle and p.status in ('active', 'draft')
        and p.id is distinct from v_target
        and (v_job.archive_project_id is null or p.id <> v_job.archive_project_id)
      group by r.row_number, r.line, r.ticket_id
    ), upd as (
      update public.import_job_rows r
         set is_valid = false, error_code = 'TICKET_ID_COLLISION',
             error_message = format('Ticket %s already belongs to project %s in this reporting cycle; it was not imported here.', hit.ticket_id, hit.other)
        from hit
       where r.job_id = p_job_id and r.row_number = hit.row_number
      returning r.row_number
    )
    insert into public.import_job_issues (job_id, severity, code, row_number, line, ticket_id, column_name, message)
    select p_job_id, 'error', 'TICKET_ID_COLLISION', hit.row_number, hit.line, hit.ticket_id, 'Ticket_ID',
           format('Ticket %s already belongs to project %s in this reporting cycle. Check that the file was exported for the selected project.', hit.ticket_id, hit.other)
      from hit
    on conflict do nothing;
  end if;

  -- Plan each valid row.
  update public.import_job_rows r
     set planned_action = case
         when not r.is_valid then 'rejected'
         when t.id is null then 'insert'
         when t.row_hash = r.row_hash then 'unchanged'
         when v_job.data_as_of < t.source_data_as_of then 'stale'
         else 'update' end
    from public.import_job_rows r2
    left join public.tickets t on t.project_id = v_target and t.ticket_id = r2.ticket_id
   where r.job_id = p_job_id and r2.job_id = r.job_id and r2.row_number = r.row_number;

  select jsonb_build_object(
    'total', count(*),
    'valid', count(*) filter (where is_valid),
    'invalid', count(*) filter (where not is_valid),
    'duplicates', count(*) filter (where error_code = 'DUPLICATE_TICKET_IN_FILE'),
    'collisions', count(*) filter (where error_code = 'TICKET_ID_COLLISION'),
    'new', count(*) filter (where planned_action = 'insert'),
    'updated', count(*) filter (where planned_action = 'update'),
    'unchanged', count(*) filter (where planned_action = 'unchanged'),
    'stale', count(*) filter (where planned_action = 'stale'))
    into v_counts
  from public.import_job_rows where job_id = p_job_id;

  -- Which source fields would change (updates only).
  select coalesce(jsonb_object_agg(x.label, x.n), '{}'::jsonb) into v_field_changes
  from (
    select f.label, count(*) n
    from public.import_job_rows r
    join public.tickets t on t.project_id = v_target and t.ticket_id = r.ticket_id
    cross join lateral (values
      ('Topic', (r.record ->> 'topic') is distinct from t.topic),
      ('Message', (r.record ->> 'message') is distinct from t.message),
      ('Status', (r.record ->> 'status') is distinct from t.status),
      ('Created_At', (r.record ->> 'created_at')::timestamptz is distinct from t.created_at),
      ('Responded_At', (r.record ->> 'responded_at')::timestamptz is distinct from t.responded_at),
      ('Resolved_At', (r.record ->> 'resolved_at')::timestamptz is distinct from t.resolved_at),
      ('Response', (r.record ->> 'response') is distinct from t.response),
      ('Note', (r.record ->> 'note') is distinct from t.note),
      ('Responder_Name', (r.record ->> 'responder_name') is distinct from t.responder_name),
      ('Resolved_By', (r.record ->> 'resolved_by') is distinct from t.resolved_by),
      ('Attachment_URLs', (r.record ->> 'attachment_urls') is distinct from t.attachment_urls),
      ('Response_Attachment_URLs', (r.record ->> 'response_attachment_urls') is distinct from t.response_attachment_urls),
      ('Other fields', (r.record ->> 'priority') is distinct from t.priority
                       or (r.record ->> 'department') is distinct from t.department
                       or (r.record ->> 'owner_type') is distinct from t.owner_type
                       or (r.record ->> 'owner_id') is distinct from t.owner_id
                       or (r.record ->> 'affected_student_id') is distinct from t.affected_student_id)
    ) as f(label, changed)
    where r.job_id = p_job_id and r.planned_action = 'update' and f.changed
    group by f.label
  ) x;

  -- Updates that remove information (possible conflicts worth reviewing).
  with reg as (
    select r.row_number, r.line, r.ticket_id,
      case
        when t.resolved_at is not null and (r.record ->> 'resolved_at') is null then 'Resolved_At would be cleared'
        when t.responded_at is not null and (r.record ->> 'responded_at') is null then 'Responded_At would be cleared'
        when private.status_class(t.status) = 'closed' and private.status_class(r.record ->> 'status') <> 'closed'
          then format('Status would change from %s back to %s', coalesce(t.status, '(missing)'), coalesce(r.record ->> 'status', '(missing)'))
        when (r.record ->> 'created_at')::timestamptz <> t.created_at then 'Created_At differs from the stored ticket'
      end as what
    from public.import_job_rows r
    join public.tickets t on t.project_id = v_target and t.ticket_id = r.ticket_id
    where r.job_id = p_job_id and r.planned_action = 'update'
  ), ins as (
    insert into public.import_job_issues (job_id, severity, code, row_number, line, ticket_id, message)
    select p_job_id, 'warning', 'UPDATE_REGRESSION', reg.row_number, reg.line, reg.ticket_id,
           reg.what || '. The newer export is applied as-is (newer export wins); review if unexpected.'
      from reg where reg.what is not null
    on conflict do nothing
    returning 1
  )
  select jsonb_build_object('count', (select count(*) from reg where reg.what is not null)) into v_regressions;

  insert into public.import_job_issues (job_id, severity, code, row_number, line, ticket_id, message)
  select p_job_id, 'warning', 'STALE_EXPORT_ROW', r.row_number, r.line, r.ticket_id,
         'This row differs from the stored ticket, but the stored ticket comes from a more recent export. It will NOT be applied (older exports never overwrite newer data).'
    from public.import_job_rows r
   where r.job_id = p_job_id and r.planned_action = 'stale'
  on conflict do nothing;

  if v_target is not null then
    select count(*) into v_absent
      from public.tickets t
     where t.project_id = v_target
       and not exists (select 1 from public.import_job_rows r where r.job_id = p_job_id and r.ticket_id = t.ticket_id);
  end if;

  -- Informational: IDs that also exist in archived/other-cycle projects (kept separate).
  select count(distinct r.ticket_id) into v_cross_archived
    from public.import_job_rows r
    join public.tickets t on t.ticket_id = r.ticket_id
    join public.projects p on p.id = t.project_id
   where r.job_id = p_job_id and r.is_valid and p.id is distinct from v_target
     and (p.status = 'archived' or p.cycle_id is distinct from v_cycle);

  if v_job.mode = 'archive_and_start' then
    select count(*) into v_in_archived_project
      from public.import_job_rows r
      join public.tickets t on t.ticket_id = r.ticket_id
      join public.projects p on p.id = t.project_id
     where r.job_id = p_job_id and r.is_valid
       and (p.id = v_job.archive_project_id or p.cycle_id = v_job.archive_cycle_id);
  end if;

  select jsonb_build_object(
    'stale_rows', (v_counts ->> 'stale')::int,
    'regressions', (v_regressions ->> 'count')::int,
    'collisions', (v_counts ->> 'collisions')::int,
    'ids_in_other_cycles_or_archived', v_cross_archived) into v_conflicts;

  v_preview := jsonb_build_object(
    'counts', v_counts,
    'field_changes', v_field_changes,
    'conflicts', v_conflicts,
    'absent_existing', v_absent,
    'ids_in_archived_target', v_in_archived_project,
    'computed_at', now());

  update public.import_jobs
     set preview = v_preview, preview_version = preview_version + 1, preview_computed_at = now(),
         rows_valid = (v_counts ->> 'valid')::int, rows_invalid = (v_counts ->> 'invalid')::int,
         warnings_count = (select count(*) from public.import_job_issues i where i.job_id = p_job_id and i.severity = 'warning')
   where id = p_job_id;
  return v_preview;
end;
$$;

create or replace function public.refresh_import_preview(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  perform private.require_role('admin');
  select status into v_status from public.import_jobs where id = p_job_id for update;
  if v_status is distinct from 'ready' then
    raise exception 'The preview can only be refreshed while the import awaits confirmation.' using errcode = '22023';
  end if;
  perform private.compute_import_preview(p_job_id);
  return (select jsonb_build_object('preview', preview, 'preview_version', preview_version) from public.import_jobs where id = p_job_id);
end;
$$;

-- Confirms a validated job: recomputes the preview (refusing if it changed since
-- the administrator reviewed it), creates the draft project/cycle when starting
-- fresh, records the import run and rejected rows, and queues the import.
create or replace function public.confirm_import_job(p_job_id uuid, p_policy text, p_preview_version integer)
returns jsonb
language plpgsql
volatile
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
  perform private.require_role('admin');
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
  v_after := (private.compute_import_preview(p_job_id)) -> 'counts';
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

-- Removes a never-activated draft project/cycle and its partial data.
create or replace function private.discard_job_drafts(p_job public.import_jobs)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tickets integer := 0;
begin
  if p_job.mode <> 'archive_and_start' or p_job.project_id is null then
    return 0;
  end if;
  if not exists (select 1 from public.projects where id = p_job.project_id and status = 'draft') then
    return 0;
  end if;
  delete from public.tickets where project_id = p_job.project_id;
  get diagnostics v_tickets = row_count;
  update public.import_runs
     set project_id = null,
         status = case when status = 'running' then 'failed' else status end,
         completed_at = coalesce(completed_at, now()),
         error_summary = coalesce(error_summary || ' ', '') || 'Draft project discarded; its partial data was removed.'
   where project_id = p_job.project_id;
  update public.import_jobs set project_id = null where id = p_job.id;
  delete from public.projects where id = p_job.project_id and status = 'draft';
  if p_job.new_cycle_id is not null then
    delete from public.reporting_cycles r
     where r.id = p_job.new_cycle_id and r.status = 'draft'
       and not exists (select 1 from public.projects p where p.cycle_id = r.id);
  end if;
  return v_tickets;
end;
$$;

create or replace function public.cancel_import_job(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
  v_discarded integer := 0;
begin
  perform private.require_role('admin');
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

-- Retries a failed job: validation restarts from scratch; an interrupted import
-- resumes where it stopped (each applied batch is already committed).
create or replace function public.retry_import_job(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
  v_next text;
begin
  perform private.require_role('admin');
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
  perform private.require_role('admin');
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
  perform private.require_role('admin');
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

create or replace function public.get_import_job_issues(
  p_job_id uuid, p_severity text default null, p_limit integer default 200, p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role('admin');
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

-- =============================================================================
-- Import jobs — worker functions (service role only)
-- =============================================================================

-- Claims a runnable job (or the given one) with a lease. Returns the context the
-- worker needs, or null when nothing is runnable.
create or replace function public.worker_claim_job(p_worker text, p_job_id uuid default null, p_lease_seconds integer default 90)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
  v_org integer;
  v_project jsonb;
begin
  perform private.require_service_role();
  select * into v_job
    from public.import_jobs j
   where j.status in ('uploaded', 'validating', 'importing')
     and (p_job_id is null or j.id = p_job_id)
     and (j.lease_expires_at is null or j.lease_expires_at < now() or j.lease_owner = p_worker)
   order by j.created_at
   limit 1
   for update skip locked;
  if v_job.id is null then
    return null;
  end if;

  if v_job.attempts >= v_job.max_attempts then
    update public.import_jobs
       set status = 'failed', error_code = 'WORKER_STALLED',
           last_error = coalesce(last_error, 'The import worker stopped repeatedly without making progress.'),
           lease_owner = null, lease_expires_at = null
     where id = v_job.id;
    if v_job.import_run_id is not null then
      update public.import_runs set status = 'failed', completed_at = now(),
             error_summary = format('Stopped after %s of %s rows; retry to resume.', v_job.rows_applied, v_job.rows_to_apply)
       where id = v_job.import_run_id and status = 'running';
    end if;
    perform private.job_event(v_job.id, 'job.failed', jsonb_build_object('reason', 'max_attempts', 'last_error', v_job.last_error));
    return null;
  end if;

  update public.import_jobs
     set status = case when status = 'uploaded' then 'validating' else status end,
         lease_owner = p_worker, lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 90), 30)),
         heartbeat_at = now(), attempts = attempts + 1,
         progress_phase = case when status = 'uploaded' then 'reading' else progress_phase end
   where id = v_job.id
  returning * into v_job;

  if v_job.mode = 'upsert' then
    select organization_id into v_org from public.projects where id = v_job.project_id;
    select jsonb_build_object('code', code, 'name', name, 'organization_id', organization_id) into v_project
      from public.projects where id = v_job.project_id;
  else
    v_org := (v_job.new_project ->> 'organization_id')::integer;
    v_project := jsonb_build_object('code', v_job.new_project ->> 'code', 'name', v_job.new_project ->> 'name',
                                    'organization_id', v_org);
  end if;

  return jsonb_build_object(
    'id', v_job.id, 'status', v_job.status, 'mode', v_job.mode, 'storage_path', v_job.storage_path,
    'original_filename', v_job.original_filename, 'file_format', v_job.file_format,
    'file_size_bytes', v_job.file_size_bytes, 'file_hash', v_job.file_hash, 'rows_staged', v_job.rows_staged,
    'rows_total', v_job.rows_total, 'attempts', v_job.attempts, 'project', v_project,
    'statuses', (select coalesce(jsonb_agg(s.status), '[]'::jsonb) from public.ticket_statuses s),
    'mapped_topics', (select coalesce(jsonb_agg(m.topic), '[]'::jsonb) from public.topic_categories m));
end;
$$;

create or replace function public.worker_heartbeat(p_job_id uuid, p_worker text, p_phase text, p_done integer, p_total integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  update public.import_jobs
     set heartbeat_at = now(), lease_expires_at = greatest(lease_expires_at, now() + interval '90 seconds'),
         progress_phase = coalesce(p_phase, progress_phase), progress_done = coalesce(p_done, progress_done),
         progress_total = coalesce(p_total, progress_total)
   where id = p_job_id and lease_owner = p_worker and status in ('validating', 'importing');
  return found;
end;
$$;

-- Records the file identity on first read; a different file on resume is an error.
create or replace function public.worker_set_file(p_job_id uuid, p_worker text, p_hash text, p_size bigint, p_rows_total integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
begin
  perform private.require_service_role();
  select * into v_job from public.import_jobs where id = p_job_id and lease_owner = p_worker and status = 'validating' for update;
  if v_job.id is null then
    return false;
  end if;
  if v_job.file_hash is not null and v_job.file_hash <> p_hash then
    raise exception 'The uploaded file changed while it was being validated.' using errcode = '22023';
  end if;
  update public.import_jobs
     set file_hash = p_hash, file_size_bytes = coalesce(p_size, file_size_bytes), rows_total = p_rows_total
   where id = p_job_id;
  return true;
end;
$$;

-- Stages a chunk of parsed rows and their row-level findings (idempotent).
create or replace function public.worker_stage_rows(p_job_id uuid, p_worker text, p_rows jsonb, p_issues jsonb default '[]'::jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_staged integer;
begin
  perform private.require_service_role();
  perform 1 from public.import_jobs where id = p_job_id and lease_owner = p_worker and status = 'validating' for update;
  if not found then
    raise exception 'LEASE_LOST: this worker no longer holds the job' using errcode = '55P03';
  end if;

  insert into public.import_job_rows (job_id, row_number, line, ticket_id, organization_id, row_hash, is_valid,
                                      record, attachments, theme, raw, error_code, error_message)
  select p_job_id, x.row_number, x.line, x.ticket_id, x.organization_id, x.row_hash, x.is_valid,
         x.record, coalesce(x.attachments, '[]'::jsonb), x.theme, x.raw, x.error_code, x.error_message
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
      row_number integer, line integer, ticket_id bigint, organization_id integer, row_hash text, is_valid boolean,
      record jsonb, attachments jsonb, theme jsonb, raw jsonb, error_code text, error_message text)
  on conflict (job_id, row_number) do nothing;

  insert into public.import_job_issues (job_id, severity, code, row_number, line, ticket_id, column_name, message, value_excerpt)
  select p_job_id, x.severity, x.code, x.row_number, x.line, x.ticket_id, x.column_name, x.message, left(x.value_excerpt, 120)
    from jsonb_to_recordset(coalesce(p_issues, '[]'::jsonb)) as x(
      severity text, code text, row_number integer, line integer, ticket_id bigint, column_name text, message text, value_excerpt text)
  on conflict do nothing;

  select count(*) into v_staged from public.import_job_rows where job_id = p_job_id;
  update public.import_jobs
     set rows_staged = v_staged, attempts = 0, heartbeat_at = now(),
         lease_expires_at = greatest(lease_expires_at, now() + interval '90 seconds'),
         progress_phase = 'staging', progress_done = v_staged, progress_total = coalesce(rows_total, v_staged)
   where id = p_job_id;
  return v_staged;
end;
$$;

-- Ends validation. A file-level error fails the job (nothing staged is imported);
-- otherwise the preview is computed and the job waits for confirmation.
create or replace function public.worker_finish_validation(p_job_id uuid, p_worker text, p_summary jsonb, p_file_issues jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
  v_file_error text := p_summary ->> 'file_error';
  v_preview jsonb;
begin
  perform private.require_service_role();
  select * into v_job from public.import_jobs where id = p_job_id and lease_owner = p_worker and status = 'validating' for update;
  if v_job.id is null then
    raise exception 'LEASE_LOST: this worker no longer holds the job' using errcode = '55P03';
  end if;

  delete from public.import_job_issues where job_id = p_job_id and row_number is null;
  insert into public.import_job_issues (job_id, severity, code, column_name, message, value_excerpt)
  select p_job_id, x.severity, x.code, x.column_name, x.message, left(x.value_excerpt, 120)
    from jsonb_to_recordset(coalesce(p_file_issues, '[]'::jsonb)) as x(
      severity text, code text, column_name text, message text, value_excerpt text);

  if v_file_error is not null then
    delete from public.import_job_rows where job_id = p_job_id;
    update public.import_jobs
       set status = 'failed', error_code = coalesce(p_summary ->> 'file_error_code', 'FILE_INVALID'), last_error = v_file_error,
           validation_summary = p_summary, rows_staged = 0, lease_owner = null, lease_expires_at = null,
           progress_phase = 'rejected'
     where id = p_job_id;
    perform private.job_event(p_job_id, 'job.rejected', jsonb_build_object('reason', v_file_error), v_job.created_by);
    return jsonb_build_object('status', 'failed', 'error', v_file_error);
  end if;

  if v_job.rows_staged <> coalesce((p_summary ->> 'rows_total')::integer, -1) then
    raise exception 'Staging incomplete: % of % rows staged.', v_job.rows_staged, p_summary ->> 'rows_total' using errcode = '22023';
  end if;

  update public.import_jobs
     set validation_summary = p_summary, rows_total = (p_summary ->> 'rows_total')::integer,
         data_as_of = nullif(p_summary #>> '{stats,data_as_of}', '')::timestamptz,
         min_created_at = nullif(p_summary #>> '{stats,min_created_at}', '')::timestamptz,
         max_created_at = nullif(p_summary #>> '{stats,max_created_at}', '')::timestamptz
   where id = p_job_id;

  v_preview := private.compute_import_preview(p_job_id);

  update public.import_jobs
     set status = 'ready', lease_owner = null, lease_expires_at = null, attempts = 0, progress_phase = 'ready'
   where id = p_job_id;
  perform private.job_event(p_job_id, 'job.validated', jsonb_build_object('counts', v_preview -> 'counts'), v_job.created_by);
  return jsonb_build_object('status', 'ready', 'preview', v_preview);
end;
$$;

-- Records a worker error. Retryable errors release the lease so the next run
-- resumes; others (or too many attempts) fail the job with the message shown.
create or replace function public.worker_fail(p_job_id uuid, p_worker text, p_message text, p_retryable boolean default true)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
begin
  perform private.require_service_role();
  select * into v_job from public.import_jobs where id = p_job_id for update;
  if v_job.id is null or v_job.status not in ('validating', 'importing') then
    return coalesce(v_job.status, 'missing');
  end if;
  if p_retryable and v_job.attempts < v_job.max_attempts then
    update public.import_jobs
       set last_error = left(p_message, 2000), lease_owner = null, lease_expires_at = now()
     where id = p_job_id;
    perform private.job_event(p_job_id, 'job.retry_scheduled', jsonb_build_object('error', left(p_message, 500), 'attempt', v_job.attempts));
    return v_job.status;
  end if;
  update public.import_jobs
     set status = 'failed', error_code = coalesce(error_code, 'WORKER_ERROR'), last_error = left(p_message, 2000),
         lease_owner = null, lease_expires_at = null
   where id = p_job_id;
  if v_job.import_run_id is not null then
    update public.import_runs set status = 'failed', completed_at = now(),
           error_summary = format('%s (applied %s of %s rows; retry to resume)', left(p_message, 1500), v_job.rows_applied, v_job.rows_to_apply)
     where id = v_job.import_run_id and status = 'running';
  end if;
  perform private.job_event(p_job_id, 'job.failed', jsonb_build_object('error', left(p_message, 500)));
  return 'failed';
end;
$$;

-- Releases the lease early (time budget used up) so the next invocation resumes at once.
create or replace function public.worker_release(p_job_id uuid, p_worker text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  update public.import_jobs
     set lease_owner = null, lease_expires_at = now(), attempts = greatest(attempts - 1, 0)
   where id = p_job_id and lease_owner = p_worker and status in ('validating', 'importing');
  return found;
end;
$$;

-- -----------------------------------------------------------------------------
-- Applying staged rows (one atomic batch per call)
-- -----------------------------------------------------------------------------
create or replace function private.finalize_import_job(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
  v_run public.import_runs%rowtype;
  v_status text;
  v_was_current boolean;
begin
  select * into v_job from public.import_jobs where id = p_job_id for update;
  select * into v_run from public.import_runs where id = v_job.import_run_id for update;
  v_status := case when v_run.rejected_count > 0 then 'completed_with_errors' else 'completed' end;

  update public.import_runs
     set status = v_status, completed_at = now(),
         error_summary = case when v_run.rejected_count > 0
           then format('%s row(s) rejected; see the rejected rows below.', v_run.rejected_count) end
   where id = v_run.id;

  -- Fresh dataset: archive the old project/cycle and activate the new one atomically.
  if v_job.mode = 'archive_and_start' then
    if v_job.archive_scope = 'project' then
      update public.projects
         set status = 'archived', archived_at = now(), archived_by = v_job.confirmed_by, archived_via = 'project',
             archive_reason = format('Replaced by %s (import %s)', v_job.new_project ->> 'code', v_job.original_filename)
       where id = v_job.archive_project_id and status = 'active';
    else
      select is_current into v_was_current from public.reporting_cycles where id = v_job.archive_cycle_id;
      update public.projects
         set status = 'archived', archived_at = now(), archived_by = v_job.confirmed_by, archived_via = 'cycle',
             archive_reason = format('Cycle replaced by %s', v_job.new_cycle ->> 'code')
       where cycle_id = v_job.archive_cycle_id and status = 'active';
      update public.reporting_cycles
         set status = 'archived', is_current = false, archived_at = now(), archived_by = v_job.confirmed_by,
             archive_reason = format('Replaced by %s', v_job.new_cycle ->> 'code')
       where id = v_job.archive_cycle_id and status = 'active';
      update public.reporting_cycles set is_current = false where is_current;
      update public.reporting_cycles set status = 'active', is_current = true where id = v_job.new_cycle_id;
    end if;
    update public.projects set status = 'active' where id = v_job.project_id and status = 'draft';
  end if;

  update public.import_jobs
     set status = v_status, completed_at = now(), lease_owner = null, lease_expires_at = null,
         progress_phase = 'completed', progress_done = rows_to_apply, progress_total = rows_to_apply
   where id = p_job_id;
  -- Staged copies are no longer needed: tickets, import_errors and ticket_changes keep the record.
  delete from public.import_job_rows where job_id = p_job_id;

  perform private.job_event(p_job_id, 'job.completed', jsonb_build_object(
    'status', v_status, 'inserted', v_run.inserted_count, 'updated', v_run.updated_count,
    'unchanged', v_run.skipped_unchanged_count, 'stale', v_run.skipped_stale_count, 'rejected', v_run.rejected_count),
    v_job.confirmed_by);
  insert into public.audit_events (user_id, action, details)
  values (v_job.confirmed_by, 'import.completed', jsonb_build_object(
    'job_id', p_job_id, 'run_id', v_run.id, 'status', v_status, 'mode', v_job.mode,
    'inserted', v_run.inserted_count, 'updated', v_run.updated_count, 'rejected', v_run.rejected_count));
  return v_status;
end;
$$;

create or replace function private.apply_import_batch(p_job_id uuid, p_batch_size integer default 500)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs%rowtype;
  v_rows integer[];
  v_project uuid;
  v_as_of timestamptz;
  v_counts record;
  v_remaining integer;
  v_status text;
  v_version text;
begin
  select * into v_job from public.import_jobs where id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'importing' then
    return jsonb_build_object('status', coalesce(v_job.status, 'missing'), 'done', true);
  end if;
  v_project := v_job.project_id;
  v_as_of := v_job.data_as_of;

  select array_agg(s.row_number order by s.row_number) into v_rows
    from (select r.row_number from public.import_job_rows r
           where r.job_id = p_job_id and r.is_valid and r.applied_at is null
           order by r.row_number
           limit least(greatest(coalesce(p_batch_size, 500), 1), 2000)) s;

  if v_rows is not null then
    -- Decide each row against the database as it is now (authoritative).
    update public.import_job_rows r
       set applied_action = case
           when t.id is null then 'insert'
           when t.row_hash = r2.row_hash then 'unchanged'
           when v_as_of < t.source_data_as_of then 'stale'
           else 'update' end,
           applied_at = now()
      from public.import_job_rows r2
      left join public.tickets t on t.project_id = v_project and t.ticket_id = r2.ticket_id
     where r.job_id = p_job_id and r.row_number = any (v_rows)
       and r2.job_id = r.job_id and r2.row_number = r.row_number;

    insert into public.tickets (
      ticket_id, project_id, organization_id, topic, message, status, priority, department, owner_type, owner_id,
      affected_student_id, created_at, responded_at, resolved_at, response, note, responder_name, resolved_by,
      attachment_urls, response_attachment_urls, sub_topic, session_ref, lesson_name, message_language,
      parser_version, source_filename, source_row_number, source_data_as_of, row_hash,
      first_import_run_id, last_import_run_id)
    select x.ticket_id, v_project, x.organization_id, x.topic, x.message, x.status, x.priority, x.department,
           x.owner_type, x.owner_id, x.affected_student_id, x.created_at, x.responded_at, x.resolved_at,
           x.response, x.note, x.responder_name, x.resolved_by, x.attachment_urls, x.response_attachment_urls,
           x.sub_topic, x.session_ref, x.lesson_name, x.message_language, x.parser_version,
           v_job.original_filename, r.row_number, v_as_of, r.row_hash, v_job.import_run_id, v_job.import_run_id
      from public.import_job_rows r
      cross join lateral jsonb_to_record(r.record) as x(
        ticket_id bigint, organization_id integer, topic text, message text, status text, priority text,
        department text, owner_type text, owner_id text, affected_student_id text, created_at timestamptz,
        responded_at timestamptz, resolved_at timestamptz, response text, note text, responder_name text,
        resolved_by text, attachment_urls text, response_attachment_urls text, sub_topic text, session_ref text,
        lesson_name text, message_language text, parser_version text)
     where r.job_id = p_job_id and r.row_number = any (v_rows) and r.applied_action = 'insert';

    update public.tickets t
       set topic = x.topic, message = x.message, status = x.status, priority = x.priority,
           department = x.department, owner_type = x.owner_type, owner_id = x.owner_id,
           affected_student_id = x.affected_student_id, created_at = x.created_at, responded_at = x.responded_at,
           resolved_at = x.resolved_at, response = x.response, note = x.note, responder_name = x.responder_name,
           resolved_by = x.resolved_by, attachment_urls = x.attachment_urls,
           response_attachment_urls = x.response_attachment_urls, sub_topic = x.sub_topic,
           session_ref = x.session_ref, lesson_name = x.lesson_name, message_language = x.message_language,
           parser_version = x.parser_version, source_filename = v_job.original_filename,
           source_row_number = r.row_number, source_data_as_of = v_as_of, row_hash = r.row_hash,
           last_import_run_id = v_job.import_run_id, updated_at = now()
      from public.import_job_rows r
      cross join lateral jsonb_to_record(r.record) as x(
        topic text, message text, status text, priority text, department text, owner_type text, owner_id text,
        affected_student_id text, created_at timestamptz, responded_at timestamptz, resolved_at timestamptz,
        response text, note text, responder_name text, resolved_by text, attachment_urls text,
        response_attachment_urls text, sub_topic text, session_ref text, lesson_name text,
        message_language text, parser_version text)
     where r.job_id = p_job_id and r.row_number = any (v_rows) and r.applied_action = 'update'
       and t.project_id = v_project and t.ticket_id = r.ticket_id;

    -- Attachments and classification for every written ticket.
    delete from public.ticket_attachments a
     using public.import_job_rows r, public.tickets t
     where r.job_id = p_job_id and r.row_number = any (v_rows) and r.applied_action in ('insert', 'update')
       and t.project_id = v_project and t.ticket_id = r.ticket_id and a.ticket_pk = t.id;

    insert into public.ticket_attachments (ticket_pk, attachment_type, position, url, url_host, file_name, file_extension)
    select t.id, a.attachment_type, a.position, a.url, a.url_host, a.file_name, a.file_extension
      from public.import_job_rows r
      join public.tickets t on t.project_id = v_project and t.ticket_id = r.ticket_id
      cross join lateral jsonb_to_recordset(r.attachments) as a(
        attachment_type text, position smallint, url text, url_host text, file_name text, file_extension text)
     where r.job_id = p_job_id and r.row_number = any (v_rows) and r.applied_action in ('insert', 'update');

    select coalesce(min(r.theme ->> 'version'), 'rules-v1') into v_version
      from public.import_job_rows r where r.job_id = p_job_id and r.row_number = any (v_rows);

    update public.ticket_classifications c
       set is_current = false
      from public.import_job_rows r
      join public.tickets t on t.project_id = v_project and t.ticket_id = r.ticket_id
     where r.job_id = p_job_id and r.row_number = any (v_rows) and r.applied_action in ('insert', 'update')
       and c.ticket_pk = t.id and c.is_current and not (c.method = 'rule_based' and c.version = v_version);

    insert into public.ticket_classifications (ticket_pk, category_id, subcategory_id, method, confidence, version, evidence, is_current)
    select t.id, private.category_id_for_topic(t.topic), sub.id, 'rule_based',
           nullif(r.theme ->> 'confidence', '')::numeric, v_version,
           jsonb_build_object(
             'topic_mapped', exists (select 1 from public.topic_categories m where m.topic = t.topic),
             'matched_terms', coalesce(r.theme -> 'matched_terms', '[]'::jsonb),
             'theme_scores', coalesce(r.theme -> 'theme_scores', '{}'::jsonb)),
           true
      from public.import_job_rows r
      join public.tickets t on t.project_id = v_project and t.ticket_id = r.ticket_id
      left join public.ticket_categories sub on sub.code = r.theme ->> 'subcategory' and sub.kind = 'subcategory'
     where r.job_id = p_job_id and r.row_number = any (v_rows) and r.applied_action in ('insert', 'update')
    on conflict (ticket_pk, method, version) do update set
      category_id = excluded.category_id,
      subcategory_id = excluded.subcategory_id,
      confidence = excluded.confidence,
      evidence = excluded.evidence,
      is_current = true,
      created_at = now();

    select count(*) filter (where applied_action = 'insert') as ins,
           count(*) filter (where applied_action = 'update') as upd,
           count(*) filter (where applied_action = 'unchanged') as same,
           count(*) filter (where applied_action = 'stale') as stale,
           count(*) as n
      into v_counts
      from public.import_job_rows r where r.job_id = p_job_id and r.row_number = any (v_rows);

    update public.import_runs
       set inserted_count = inserted_count + v_counts.ins, updated_count = updated_count + v_counts.upd,
           skipped_unchanged_count = skipped_unchanged_count + v_counts.same,
           skipped_stale_count = skipped_stale_count + v_counts.stale
     where id = v_job.import_run_id;

    update public.import_jobs
       set rows_applied = rows_applied + v_counts.n, progress_done = rows_applied + v_counts.n,
           attempts = 0, heartbeat_at = now(), last_error = null
     where id = p_job_id;
  end if;

  select count(*) into v_remaining
    from public.import_job_rows r where r.job_id = p_job_id and r.is_valid and r.applied_at is null;
  if v_remaining = 0 then
    v_status := private.finalize_import_job(p_job_id);
    return jsonb_build_object('status', v_status, 'done', true, 'applied', coalesce(array_length(v_rows, 1), 0), 'remaining', 0);
  end if;
  return jsonb_build_object('status', 'importing', 'done', false, 'applied', coalesce(array_length(v_rows, 1), 0),
                            'remaining', v_remaining);
end;
$$;

create or replace function public.worker_apply_batch(p_job_id uuid, p_worker text, p_batch_size integer default 500)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text;
begin
  perform private.require_service_role();
  select lease_owner into v_owner from public.import_jobs where id = p_job_id for update;
  if v_owner is distinct from p_worker then
    raise exception 'LEASE_LOST: this worker no longer holds the job' using errcode = '55P03';
  end if;
  update public.import_jobs set lease_expires_at = now() + interval '90 seconds', heartbeat_at = now() where id = p_job_id;
  return private.apply_import_batch(p_job_id, p_batch_size);
end;
$$;

-- =============================================================================
-- Background driver (pg_cron). Applies confirmed imports in SQL and nudges the
-- web worker for jobs that still need parsing. Runs every 15 seconds.
-- =============================================================================

-- Asks the web worker (if configured in Vault) to pick up a job.
create or replace function private.kick_worker(p_job_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'import_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'import_worker_secret';
  if v_url is null or v_secret is null then
    return false;
  end if;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('jobId', p_job_id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 10000);
  return true;
end;
$$;

-- Transaction control (COMMIT between batches) requires a procedure without SET
-- clauses; every name is therefore schema-qualified.
create or replace procedure private.run_import_jobs()
language plpgsql
as $$
declare
  v_deadline timestamptz := clock_timestamp() + interval '20 seconds';
  v_job record;
  v_id uuid;
  v_result jsonb;
  v_message text;
begin
  -- Housekeeping: uploads never completed within 24 hours.
  update public.import_jobs
     set status = 'cancelled', cancelled_at = now(), last_error = 'Upload was not completed within 24 hours.'
   where status = 'awaiting_upload' and created_at < now() - interval '24 hours';

  -- Parsing happens in the web worker: nudge it for queued or abandoned jobs.
  for v_job in
    select j.id, j.attempts, j.max_attempts, j.import_run_id, j.last_error
      from public.import_jobs j
     where j.status in ('uploaded', 'validating')
       and (j.lease_expires_at is null or j.lease_expires_at < now())
       and (j.last_kick_at is null or j.last_kick_at < now() - interval '45 seconds')
     for update skip locked
  loop
    if v_job.attempts >= v_job.max_attempts then
      update public.import_jobs
         set status = 'failed', error_code = 'WORKER_STALLED', lease_owner = null, lease_expires_at = null,
             last_error = coalesce(v_job.last_error, 'Validation did not complete after repeated attempts.')
       where id = v_job.id;
      perform private.job_event(v_job.id, 'job.failed', jsonb_build_object('reason', 'max_attempts'));
    elsif private.kick_worker(v_job.id) then
      update public.import_jobs set last_kick_at = now() where id = v_job.id;
    end if;
  end loop;
  commit;

  -- Confirmed imports are applied right here, batch by batch.
  loop
    exit when clock_timestamp() > v_deadline;
    v_id := null;
    select j.id into v_id
      from public.import_jobs j
     where j.status = 'importing'
       and (j.lease_expires_at is null or j.lease_expires_at < now() or j.lease_owner = 'pg_cron')
     order by j.confirmed_at
     limit 1
     for update skip locked;
    exit when v_id is null;

    begin
      update public.import_jobs
         set lease_owner = 'pg_cron', lease_expires_at = now() + interval '60 seconds', heartbeat_at = now()
       where id = v_id;
      v_result := private.apply_import_batch(v_id, 1000);
    exception when others then
      get stacked diagnostics v_message = message_text;
      update public.import_jobs
         set attempts = attempts + 1, last_error = left(v_message, 2000), lease_owner = null,
             lease_expires_at = now() + interval '30 seconds'
       where id = v_id;
      update public.import_jobs
         set status = 'failed', error_code = 'IMPORT_ERROR', lease_expires_at = null
       where id = v_id and attempts >= max_attempts;
      update public.import_runs r
         set status = 'failed', completed_at = now(),
             error_summary = format('%s (applied %s of %s rows; retry to resume)', left(v_message, 1500), j.rows_applied, j.rows_to_apply)
        from public.import_jobs j
       where j.id = v_id and j.status = 'failed' and r.id = j.import_run_id and r.status = 'running';
      v_result := null;
    end;
    commit;
  end loop;
end;
$$;

-- Schedule (idempotent).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'cs-tickets-import-jobs') then
    perform cron.unschedule('cs-tickets-import-jobs');
  end if;
  perform cron.schedule('cs-tickets-import-jobs', '15 seconds', 'call private.run_import_jobs()');
end;
$$;

-- =============================================================================
-- Privileges
-- =============================================================================
revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon;

-- Administrator / analyst functions (each checks the role itself).
grant execute on function
  public.create_reporting_cycle(jsonb, boolean),
  public.update_reporting_cycle(text, text, text),
  public.set_current_cycle(text),
  public.archive_cycle(text, text, text, text),
  public.restore_cycle(text, boolean),
  public.create_project(jsonb, text),
  public.update_project(text, jsonb),
  public.archive_project(text, text, text),
  public.restore_project(text),
  public.get_project_history(text),
  public.get_topic_mappings(),
  public.set_topic_category(text, text),
  public.upsert_category(text, text, text, text, boolean),
  public.get_status_values(),
  public.set_status_class(text, text, text),
  public.update_insight_rule(text, numeric),
  public.create_import_job(jsonb),
  public.mark_import_uploaded(uuid),
  public.refresh_import_preview(uuid),
  public.confirm_import_job(uuid, text, integer),
  public.cancel_import_job(uuid),
  public.retry_import_job(uuid),
  public.get_import_jobs(integer),
  public.get_import_job(uuid),
  public.get_import_job_issues(uuid, text, integer, integer)
to authenticated;

-- Worker functions: service role only.
revoke all on function
  public.worker_claim_job(text, uuid, integer),
  public.worker_heartbeat(uuid, text, text, integer, integer),
  public.worker_set_file(uuid, text, text, bigint, integer),
  public.worker_stage_rows(uuid, text, jsonb, jsonb),
  public.worker_finish_validation(uuid, text, jsonb, jsonb),
  public.worker_fail(uuid, text, text, boolean),
  public.worker_release(uuid, text),
  public.worker_apply_batch(uuid, text, integer)
from authenticated;
grant execute on function
  public.worker_claim_job(text, uuid, integer),
  public.worker_heartbeat(uuid, text, text, integer, integer),
  public.worker_set_file(uuid, text, text, bigint, integer),
  public.worker_stage_rows(uuid, text, jsonb, jsonb),
  public.worker_finish_validation(uuid, text, jsonb, jsonb),
  public.worker_fail(uuid, text, text, boolean),
  public.worker_release(uuid, text),
  public.worker_apply_batch(uuid, text, integer)
to service_role;

grant execute on function private.require_service_role() to service_role;
grant usage on schema private to service_role;

-- Helpers used inside RLS policies must stay executable by authenticated.
grant execute on function private.current_app_role() to authenticated;
grant execute on function private.has_app_access() to authenticated;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.require_role(text) to authenticated;
