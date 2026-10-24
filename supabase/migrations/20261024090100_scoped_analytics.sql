-- =============================================================================
-- CS Tickets Analytics — scoped analytics (reporting cycles, archived projects,
-- configurable status classes, coverage-aware period comparison).
--
-- Scope keys accepted in every filters object (in addition to the existing ones):
--   cycle             reporting cycle code; default = the current cycle
--   include_archived  true to include archived projects of an active cycle
-- An archived cycle is always shown with its (archived) projects. Draft
-- projects are never analysed. Analytics never combine two cycles.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Scope primitives
-- -----------------------------------------------------------------------------
create or replace function private.scope_cycle_id(f jsonb)
returns uuid
language sql
stable
set search_path = ''
as $$
  select rc.id
  from public.reporting_cycles rc
  where rc.status <> 'draft'
    and case when nullif(f ->> 'cycle', '') is null then rc.is_current else rc.code = f ->> 'cycle' end
  limit 1;
$$;

-- Projects inside the analytical scope (cycle + lifecycle + project/program/intake filters).
create or replace function private.scope_projects(f jsonb)
returns setof public.projects
language sql
stable
set search_path = ''
as $$
  select p.*
  from public.projects p
  join public.reporting_cycles rc on rc.id = p.cycle_id
  where rc.id = private.scope_cycle_id(f)
    and (p.status = 'active'
         or (p.status = 'archived' and (rc.status = 'archived' or coalesce(f -> 'include_archived' = 'true'::jsonb, false))))
    and (private.jarr(f -> 'projects') is null or p.code = any (private.jarr(f -> 'projects')))
    and (private.jarr(f -> 'programs') is null or p.program = any (private.jarr(f -> 'programs')))
    and (private.jarr(f -> 'intakes') is null or p.intake = any (private.jarr(f -> 'intakes')));
$$;

create or replace function private.filtered_tickets(f jsonb)
returns setof public.tickets
language sql
stable
parallel safe
set search_path = ''
as $$
  with fx as materialized (
    select
      private.jarr(f -> 'statuses')       as statuses,
      private.jarr(f -> 'topics')         as topics,
      private.jarr(f -> 'responders')     as responders,
      private.jarr(f -> 'resolvers')      as resolvers,
      private.jarr(f -> 'categories')     as categories,
      private.jarr(f -> 'subcategories')  as subcategories,
      private.jarr(f -> 'response_kinds') as response_kinds,
      nullif(f ->> 'date_from', '')::date as date_from,
      nullif(f ->> 'date_to', '')::date   as date_to,
      nullif(f ->> 'session_ref', '')     as session_ref,
      nullif(f ->> 'lesson', '')          as lesson
  ),
  sp as materialized (select s.id from private.scope_projects(f) s)
  select t.*
  from public.tickets t
  join sp on sp.id = t.project_id
  cross join fx
  where (fx.date_from is null or t.created_date >= fx.date_from)
    and (fx.date_to is null or t.created_date <= fx.date_to)
    and (fx.statuses is null or coalesce(t.status, '__none__') = any (fx.statuses))
    and (fx.topics is null or t.topic = any (fx.topics))
    and (fx.responders is null or coalesce(t.responder_name, '__none__') = any (fx.responders))
    and (fx.resolvers is null or coalesce(t.resolved_by, '__none__') = any (fx.resolvers))
    and (fx.response_kinds is null or t.response_kind = any (fx.response_kinds))
    and (fx.session_ref is null or t.session_ref = fx.session_ref)
    and (fx.lesson is null or t.lesson_name = fx.lesson)
    and (fx.categories is null or exists (
          select 1
          from public.ticket_classifications c
          join public.ticket_categories k on k.id = c.category_id
          where c.ticket_pk = t.id and c.is_current and k.code = any (fx.categories)))
    and (fx.subcategories is null or exists (
          select 1
          from public.ticket_classifications c
          join public.ticket_categories k on k.id = c.subcategory_id
          where c.ticket_pk = t.id and c.is_current and k.code = any (fx.subcategories)));
$$;

drop function if exists private.enriched_tickets(jsonb);
create function private.enriched_tickets(f jsonb)
returns table (
  id bigint,
  ticket_id bigint,
  project_id uuid,
  project_code text,
  project_name text,
  program text,
  intake text,
  intake_group text,
  topic text,
  status text,
  status_class text,
  is_open boolean,
  responder_name text,
  resolved_by text,
  owner_id text,
  lesson_name text,
  session_ref text,
  response_kind text,
  has_note boolean,
  created_at timestamptz,
  responded_at timestamptz,
  resolved_at timestamptz,
  created_date date,
  created_hour smallint,
  created_isodow smallint,
  response_seconds bigint,
  resolution_seconds bigint,
  category_code text,
  category_name text,
  subcategory_code text,
  subcategory_name text,
  snapshot_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    t.id, t.ticket_id, t.project_id, p.code, p.name, p.program, p.intake, p.intake_group,
    t.topic, t.status, coalesce(st.status_class, 'unclassified'),
    -- Open = no resolution timestamp and a status classified as open (unclassified values count as open).
    (t.resolved_at is null and coalesce(st.status_class, 'unclassified') <> 'closed'),
    t.responder_name, t.resolved_by, t.owner_id, t.lesson_name,
    t.session_ref, t.response_kind, (t.note is not null),
    t.created_at, t.responded_at, t.resolved_at, t.created_date, t.created_hour,
    t.created_isodow, t.response_seconds, t.resolution_seconds,
    cat.code, cat.name_en, sub.code, sub.name_en, s.snapshot_at
  from private.filtered_tickets(f) t
  join public.projects p on p.id = t.project_id
  left join public.ticket_statuses st on st.status = coalesce(t.status, '__none__')
  left join private.project_snapshots s on s.project_id = t.project_id
  left join public.ticket_classifications c on c.ticket_pk = t.id and c.is_current
  left join public.ticket_categories cat on cat.id = c.category_id
  left join public.ticket_categories sub on sub.id = c.subcategory_id;
$$;

-- Last complete calendar day (Africa/Cairo) covered by a project's latest export.
create or replace function private.project_coverage(f jsonb)
returns table (
  project_id uuid,
  code text,
  name text,
  status text,
  display_order smallint,
  tickets bigint,
  first_date date,
  last_date date,
  snapshot_at timestamptz,
  last_complete_date date
)
language sql
stable
set search_path = ''
as $$
  select p.id, p.code, p.name, p.status, p.display_order,
    count(t.id), min(t.created_date), max(t.created_date), s.snapshot_at,
    ((s.snapshot_at at time zone 'Africa/Cairo')::date - 1)
  from private.scope_projects(f) p
  left join public.tickets t on t.project_id = p.id
  left join private.project_snapshots s on s.project_id = p.id
  group by p.id, p.code, p.name, p.status, p.display_order, s.snapshot_at;
$$;

-- -----------------------------------------------------------------------------
-- Scope catalog: every non-draft cycle with its projects (for the scope selector)
-- -----------------------------------------------------------------------------
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
        where p.cycle_id = rc.id and p.status <> 'draft'), '[]'::jsonb))
      order by rc.is_current desc, (rc.status = 'archived'), rc.display_order, rc.created_at desc)
    from public.reporting_cycles rc
    where rc.status <> 'draft'), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Filter options and dataset coverage (for the resolved scope)
-- -----------------------------------------------------------------------------
drop function if exists public.get_filter_options();
create function public.get_filter_options(p_scope jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_scope jsonb := jsonb_strip_nulls(jsonb_build_object(
    'cycle', nullif(p_scope ->> 'cycle', ''),
    'include_archived', coalesce(p_scope -> 'include_archived' = 'true'::jsonb, false)));
  v_cycle uuid;
  v jsonb;
begin
  perform private.require_role('analyst');
  v_cycle := private.scope_cycle_id(v_scope);

  with tk as materialized (select * from private.filtered_tickets(v_scope))
  select jsonb_build_object(
    'scope', (
      select jsonb_build_object(
        'cycle', rc.code, 'cycle_name', rc.name, 'cycle_status', rc.status, 'is_current', rc.is_current,
        'include_archived', coalesce(v_scope -> 'include_archived' = 'true'::jsonb, false) or rc.status = 'archived',
        'requested_cycle', v_scope ->> 'cycle')
      from public.reporting_cycles rc where rc.id = v_cycle),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', p.code, 'name', p.name, 'program', p.program, 'intake', p.intake,
        'intake_group', p.intake_group, 'organization_id', p.organization_id,
        'status', p.status, 'is_active', p.status = 'active') order by p.display_order, p.code)
      from private.scope_projects(v_scope) p), '[]'::jsonb),
    'programs', coalesce((select jsonb_agg(distinct p.program) from private.scope_projects(v_scope) p), '[]'::jsonb),
    'intakes', coalesce((select jsonb_agg(distinct p.intake) from private.scope_projects(v_scope) p), '[]'::jsonb),
    'statuses', coalesce((
      select jsonb_agg(jsonb_build_object('value', x.v, 'count', x.n, 'class', coalesce(st.status_class, 'unclassified'),
                                          'label', st.label) order by x.n desc, x.v)
      from (select coalesce(t.status, '__none__') v, count(*) n from tk t group by 1) x
      left join public.ticket_statuses st on st.status = x.v), '[]'::jsonb),
    'topics', coalesce((
      select jsonb_agg(jsonb_build_object('value', x.v, 'count', x.n) order by x.n desc, x.v)
      from (select t.topic v, count(*) n from tk t group by 1) x), '[]'::jsonb),
    'responders', coalesce((
      select jsonb_agg(jsonb_build_object('value', x.v, 'count', x.n) order by x.n desc, x.v)
      from (select coalesce(t.responder_name, '__none__') v, count(*) n from tk t group by 1) x), '[]'::jsonb),
    'resolvers', coalesce((
      select jsonb_agg(jsonb_build_object('value', x.v, 'count', x.n) order by x.n desc, x.v)
      from (select coalesce(t.resolved_by, '__none__') v, count(*) n from tk t group by 1) x), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('code', k.code, 'name', k.name_en, 'name_ar', k.name_ar,
                                          'kind', k.kind) order by k.kind, k.sort_order)
      from public.ticket_categories k where k.is_active), '[]'::jsonb),
    'date_range', (
      select jsonb_build_object('min', min(t.created_date), 'max', max(t.created_date),
                                'min_at', min(t.created_at), 'max_at', max(t.created_at))
      from tk t),
    'latest_import', (
      select jsonb_build_object('completed_at', max(r.completed_at), 'data_as_of', max(r.data_as_of),
                                'earliest_data_as_of', min(s.snapshot_at))
      from private.scope_projects(v_scope) p
      left join public.import_runs r on r.project_id = p.id and r.status in ('completed', 'completed_with_errors')
      left join private.project_snapshots s on s.project_id = p.id),
    'coverage', coalesce((
      select jsonb_agg(jsonb_build_object(
        'project', c.code, 'name', c.name, 'status', c.status, 'tickets', c.tickets,
        'first_date', c.first_date, 'last_date', c.last_date, 'snapshot_at', c.snapshot_at,
        'last_complete_date', c.last_complete_date) order by c.display_order, c.code)
      from private.project_coverage(v_scope) c), '[]'::jsonb),
    'active_imports', coalesce((
      select jsonb_agg(jsonb_build_object('project', p.code, 'status', j.status, 'rows_applied', j.rows_applied,
                                          'rows_to_apply', j.rows_to_apply, 'started_at', j.confirmed_at))
      from public.import_jobs j join private.scope_projects(v_scope) p on p.id = j.project_id
      where j.status = 'importing'), '[]'::jsonb),
    -- Imports that stopped part-way (some batches applied) and were not completed by a later import.
    'partial_imports', coalesce((
      select jsonb_agg(jsonb_build_object('project', p.code, 'rows_applied', j.rows_applied, 'rows_to_apply', j.rows_to_apply))
      from public.import_jobs j join private.scope_projects(v_scope) p on p.id = j.project_id
      where j.mode = 'upsert' and j.status in ('failed', 'cancelled')
        and j.rows_applied > 0 and j.rows_applied < coalesce(j.rows_to_apply, 0)
        and not exists (select 1 from public.import_runs r2
                         where r2.project_id = j.project_id and r2.status in ('completed', 'completed_with_errors')
                           and r2.started_at > j.confirmed_at)), '[]'::jsonb),
    -- Latest completed import per project that rejected rows.
    'latest_rejections', coalesce((
      select jsonb_agg(jsonb_build_object('project', x.code, 'rejected', x.rejected_count, 'source_filename', x.source_filename))
      from (
        select distinct on (r.project_id) p.code, r.rejected_count, r.source_filename
        from public.import_runs r join private.scope_projects(v_scope) p on p.id = r.project_id
        where r.status in ('completed', 'completed_with_errors')
        order by r.project_id, r.completed_at desc
      ) x where x.rejected_count > 0), '[]'::jsonb),
    'unmapped_topics', (
      select count(distinct t.topic) from tk t
      where not exists (select 1 from public.topic_categories m where m.topic = t.topic)),
    'unclassified_status_tickets', (
      select count(*) from tk t
      where not exists (select 1 from public.ticket_statuses st where st.status = coalesce(t.status, '__none__'))),
    'total_tickets', (select count(*) from tk)
  ) into v;

  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grouped metrics
-- -----------------------------------------------------------------------------
create or replace function public.get_grouped_metrics(
  p_filters jsonb default '{}'::jsonb,
  p_dimension text default 'none',
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_resp_th numeric := private.threshold_seconds('response_hours');
  v_res_th numeric := private.threshold_seconds('resolution_hours');
  v jsonb;
begin
  perform private.require_role('analyst');

  if p_dimension not in ('none', 'project', 'program', 'intake', 'intake_group', 'topic',
                         'category', 'subcategory', 'responder', 'resolver', 'status',
                         'response_kind', 'lesson', 'month') then
    raise exception 'Unsupported dimension: %', p_dimension using errcode = '22023';
  end if;
  p_limit := least(greatest(coalesce(p_limit, 200), 1), 1000);

  with keyed as (
    select e.*,
      case p_dimension
        when 'none' then 'all'
        when 'project' then e.project_code
        when 'program' then e.program
        when 'intake' then e.intake
        when 'intake_group' then e.intake_group
        when 'topic' then e.topic
        when 'category' then coalesce(e.category_code, '__none__')
        when 'subcategory' then coalesce(e.subcategory_code, '__none__')
        when 'responder' then coalesce(e.responder_name, '__none__')
        when 'resolver' then coalesce(e.resolved_by, '__none__')
        when 'status' then coalesce(e.status, '__none__')
        when 'response_kind' then e.response_kind
        when 'lesson' then coalesce(e.lesson_name, '__none__')
        when 'month' then to_char(e.created_date, 'YYYY-MM')
      end as gkey,
      case p_dimension
        when 'project' then e.project_name
        when 'category' then e.category_name
        when 'subcategory' then e.subcategory_name
      end as glabel
    from private.enriched_tickets(p_filters) e
  ),
  agg as (
    select
      k.gkey as key,
      coalesce(max(k.glabel), k.gkey) as label,
      count(*) as tickets,
      count(*) filter (where k.status = 'completed') as completed,
      count(*) filter (where k.status = 'pending') as pending,
      count(*) filter (where k.status = 'rejected') as rejected,
      count(*) filter (where k.status is null) as missing_status,
      count(*) filter (where k.status is not null
                       and k.status not in ('completed', 'pending', 'rejected')) as other_status,
      count(*) filter (where k.status_class = 'closed') as closed_status,
      count(*) filter (where k.status_class = 'unclassified') as unclassified_status,
      count(*) filter (where k.is_open) as open_tickets,
      count(k.responded_at) as with_response_ts,
      count(k.resolved_at) as with_resolution_ts,
      count(*) filter (where k.has_note) as with_note,
      count(*) filter (where k.response_kind = 'generic_acknowledgement') as generic_ack,
      count(distinct k.owner_id) as unique_owners,
      count(*) filter (where k.response_seconds >= 0) as response_n,
      count(*) filter (where k.response_seconds < 0) as response_invalid,
      round(avg(k.response_seconds) filter (where k.response_seconds >= 0)) as response_avg_s,
      round((percentile_cont(0.5) within group (order by k.response_seconds)
             filter (where k.response_seconds >= 0))::numeric) as response_median_s,
      round((percentile_cont(0.9) within group (order by k.response_seconds)
             filter (where k.response_seconds >= 0))::numeric) as response_p90_s,
      count(*) filter (where k.response_seconds > v_resp_th) as response_breaches,
      count(*) filter (where k.resolution_seconds >= 0) as resolution_n,
      count(*) filter (where k.resolution_seconds < 0) as resolution_invalid,
      round(avg(k.resolution_seconds) filter (where k.resolution_seconds >= 0)) as resolution_avg_s,
      round((percentile_cont(0.5) within group (order by k.resolution_seconds)
             filter (where k.resolution_seconds >= 0))::numeric) as resolution_median_s,
      round((percentile_cont(0.9) within group (order by k.resolution_seconds)
             filter (where k.resolution_seconds >= 0))::numeric) as resolution_p90_s,
      count(*) filter (where k.resolution_seconds > v_res_th) as resolution_breaches,
      count(*) filter (where k.is_open
                       and extract(epoch from (k.snapshot_at - k.created_at)) > v_res_th) as open_breaches,
      min(k.created_at) as first_created_at,
      max(k.created_at) as last_created_at
    from keyed k
    group by k.gkey
  )
  select coalesce(jsonb_agg(to_jsonb(a) order by a.tickets desc, a.key), '[]'::jsonb)
    into v
  from (select * from agg order by tickets desc, key limit p_limit) a;

  return jsonb_build_object(
    'dimension', p_dimension,
    'thresholds', jsonb_build_object('response_seconds', v_resp_th, 'resolution_seconds', v_res_th),
    'rows', v
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Backlog (open = configurable status classes) and reconstructed backlog
-- -----------------------------------------------------------------------------
create or replace function public.get_backlog(
  p_filters jsonb default '{}'::jsonb,
  p_oldest_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_res_th numeric := private.threshold_seconds('resolution_hours');
  v_open jsonb;
  v_oldest jsonb;
  v_snapshots jsonb;
  v_reconstructed jsonb;
  v_topics jsonb;
  v_classes jsonb;
begin
  perform private.require_role('analyst');
  p_oldest_limit := least(greatest(coalesce(p_oldest_limit, 25), 1), 200);

  with o as (
    select e.*, extract(epoch from (e.snapshot_at - e.created_at)) as age_s
    from private.enriched_tickets(p_filters) e
    where e.is_open
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'project', x.project_code, 'status', x.status, 'age_bucket', x.bucket, 'count', x.n)
           order by x.project_code, x.bucket, x.status), '[]'::jsonb)
    into v_open
  from (
    select o.project_code, coalesce(o.status, '__none__') status,
      case
        when o.age_s < 24 * 3600 then 'lt_24h'
        when o.age_s < 72 * 3600 then '1_3d'
        when o.age_s < 168 * 3600 then '3_7d'
        else 'gt_7d'
      end as bucket,
      count(*) n
    from o
    group by 1, 2, 3
  ) x;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.age_seconds desc), '[]'::jsonb)
    into v_oldest
  from (
    select e.ticket_id, e.project_code, e.project_name, e.topic,
      coalesce(e.status, '__none__') as status, e.created_at, e.responded_at,
      e.responder_name, e.snapshot_at,
      round(extract(epoch from (e.snapshot_at - e.created_at))) as age_seconds,
      (extract(epoch from (e.snapshot_at - e.created_at)) > v_res_th) as breaches_resolution_threshold
    from private.enriched_tickets(p_filters) e
    where e.is_open
    order by e.snapshot_at - e.created_at desc
    limit p_oldest_limit
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('topic', x.topic, 'count', x.n) order by x.n desc), '[]'::jsonb)
    into v_topics
  from (
    select e.topic, count(*) n
    from private.enriched_tickets(p_filters) e
    where e.is_open
    group by 1
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('project', p.code, 'snapshot_at', s.snapshot_at)
                            order by p.display_order), '[]'::jsonb)
    into v_snapshots
  from private.scope_projects(p_filters) p
  join private.project_snapshots s on s.project_id = p.id;

  -- Which raw statuses counted as open/closed, so the page can state the definition.
  select coalesce(jsonb_agg(jsonb_build_object('status', x.status, 'class', x.cls, 'count', x.n) order by x.n desc), '[]'::jsonb)
    into v_classes
  from (
    select coalesce(e.status, '__none__') as status, e.status_class as cls, count(*) n
    from private.enriched_tickets(p_filters) e
    group by 1, 2
  ) x;

  with tk as (
    select e.created_date,
           (e.resolved_at at time zone 'Africa/Cairo')::date as resolved_date
    from private.enriched_tickets(p_filters) e
    where e.resolved_at is not null and e.resolution_seconds >= 0
  ),
  bounds as (
    select min(created_date) d0, max(greatest(created_date, resolved_date)) d1 from tk
  ),
  days as (
    select gs::date as d from bounds, generate_series(bounds.d0::timestamp, bounds.d1::timestamp, interval '1 day') gs
    where bounds.d0 is not null
  ),
  c as (select created_date d, count(*) n from tk group by 1),
  r as (select resolved_date d, count(*) n from tk group by 1),
  series as (
    select days.d,
      sum(coalesce(c.n, 0)) over (order by days.d) - sum(coalesce(r.n, 0)) over (order by days.d) as open_n,
      coalesce(c.n, 0) as created_n,
      coalesce(r.n, 0) as resolved_n
    from days
    left join c on c.d = days.d
    left join r on r.d = days.d
  )
  select coalesce(jsonb_agg(jsonb_build_object('date', s.d, 'open', s.open_n,
                                               'created', s.created_n, 'resolved', s.resolved_n)
                            order by s.d), '[]'::jsonb)
    into v_reconstructed
  from series s;

  return jsonb_build_object(
    'resolution_threshold_seconds', v_res_th,
    'open', v_open,
    'oldest', v_oldest,
    'open_by_topic', v_topics,
    'snapshots', v_snapshots,
    'status_classes', v_classes,
    'reconstructed', v_reconstructed
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Period-over-period comparison that respects each project's data coverage.
--
--  * aligned (default, or p_days given): every project is compared over ITS OWN
--    latest N complete days (ending the day before its export snapshot) versus
--    the N days before that. Projects exported on different dates are therefore
--    never compared against a window they have no data for.
--  * calendar (explicit date_from/date_to): one calendar window for everyone;
--    projects whose export ends before the window ends are excluded.
-- In both modes a project is only included when it already had tickets at the
-- start of the previous window (otherwise an intake launch would look like growth).
-- -----------------------------------------------------------------------------
create or replace function public.get_period_comparison(
  p_filters jsonb default '{}'::jsonb,
  p_dimension text default 'topic',
  p_days integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb := coalesce(p_filters, '{}'::jsonb) - 'date_from' - 'date_to';
  v_from date := nullif(p_filters ->> 'date_from', '')::date;
  v_to date := nullif(p_filters ->> 'date_to', '')::date;
  v_mode text;
  v_len integer;
  v_projects jsonb;
  v_rows jsonb;
  v_totals jsonb;
  v_span jsonb;
  v_windows jsonb;
begin
  perform private.require_role('analyst');
  if p_dimension not in ('none', 'project', 'program', 'topic', 'category', 'subcategory') then
    raise exception 'Unsupported dimension: %', p_dimension using errcode = '22023';
  end if;

  if p_days is not null or (v_from is null and v_to is null) then
    v_mode := 'aligned';
    v_len := least(greatest(coalesce(p_days, 30), 1), 366);
  else
    v_mode := 'calendar';
    if v_to is null then
      select max(c.last_complete_date) into v_to from private.project_coverage(v_base) c;
    end if;
    v_from := coalesce(v_from, v_to - 29);
    v_len := (v_to - v_from) + 1;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'project_id', w.project_id, 'code', w.code, 'name', w.name, 'display_order', w.display_order,
           'first_date', w.first_date, 'last_complete_date', w.last_complete_date,
           'cur_from', w.cur_to - (v_len - 1), 'cur_to', w.cur_to,
           'prev_from', w.cur_to - (2 * v_len - 1), 'prev_to', w.cur_to - v_len,
           'reason', case
             when w.first_date is null or w.cur_to is null then 'no_data'
             when v_mode = 'calendar' and w.last_complete_date < v_to then 'export_ends_before_period'
             when w.first_date > w.cur_to - (2 * v_len - 1) then 'insufficient_history'
             else 'ok'
           end)), '[]'::jsonb)
    into v_windows
  from (
    select c.*,
      case when v_mode = 'aligned' then least(c.last_complete_date, coalesce(v_to, c.last_complete_date)) else v_to end as cur_to
    from private.project_coverage(v_base) c
  ) w;

  with w as materialized (
    select * from jsonb_to_recordset(v_windows) as x(
      project_id uuid, code text, name text, display_order integer, first_date date, last_complete_date date,
      cur_from date, cur_to date, prev_from date, prev_to date, reason text)
  ),
  e as materialized (
    select e.*, w.cur_from, w.cur_to, w.prev_from, w.prev_to
    from private.enriched_tickets(v_base) e
    join w on w.project_id = e.project_id and w.reason = 'ok'
    where e.created_date between w.prev_from and w.cur_to
  ),
  per_project as (
    select e.project_id,
      count(*) filter (where e.created_date between e.cur_from and e.cur_to) as cur,
      count(*) filter (where e.created_date between e.prev_from and e.prev_to) as prev
    from e group by e.project_id
  )
  select
    coalesce((
      select jsonb_agg(jsonb_build_object('key', x.key, 'label', x.label, 'current', x.cur, 'previous', x.prev)
                       order by x.cur desc, x.key)
      from (
        select
          case p_dimension
            when 'none' then 'all'
            when 'project' then e.project_code
            when 'program' then e.program
            when 'topic' then e.topic
            when 'category' then coalesce(e.category_code, '__none__')
            when 'subcategory' then coalesce(e.subcategory_code, '__none__')
          end as key,
          max(case p_dimension
            when 'project' then e.project_name
            when 'category' then e.category_name
            when 'subcategory' then e.subcategory_name
          end) as label,
          count(*) filter (where e.created_date between e.cur_from and e.cur_to) as cur,
          count(*) filter (where e.created_date between e.prev_from and e.prev_to) as prev
        from e
        group by 1
      ) x), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'project', w.code, 'name', w.name, 'included', w.reason = 'ok', 'reason', w.reason,
               'first_date', w.first_date, 'last_complete_date', w.last_complete_date,
               'current_from', w.cur_from, 'current_to', w.cur_to,
               'previous_from', w.prev_from, 'previous_to', w.prev_to,
               'current', coalesce(n.cur, 0), 'previous', coalesce(n.prev, 0))
               order by w.display_order, w.code)
      from w left join per_project n on n.project_id = w.project_id), '[]'::jsonb),
    jsonb_build_object('current', coalesce((select sum(cur) from per_project), 0),
                       'previous', coalesce((select sum(prev) from per_project), 0)),
    (select jsonb_build_object('cur_from', min(w.cur_from), 'cur_to', max(w.cur_to),
                               'prev_from', min(w.prev_from), 'prev_to', max(w.prev_to))
       from w where w.reason = 'ok' having count(*) > 0)
    into v_rows, v_projects, v_totals, v_span;

  return jsonb_build_object(
    'dimension', p_dimension,
    'mode', v_mode,
    'days', v_len,
    -- Overall span of the compared windows (projects may use different dates in aligned mode).
    'current', case when v_span is null then null else jsonb_build_object(
      'from', v_span ->> 'cur_from', 'to', v_span ->> 'cur_to', 'days', v_len) end,
    'previous', case when v_span is null then null else jsonb_build_object(
      'from', v_span ->> 'prev_from', 'to', v_span ->> 'prev_to', 'days', v_len) end,
    'totals', v_totals,
    'projects', v_projects,
    'rows', v_rows
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Recurring sessions (open = configurable status classes)
-- -----------------------------------------------------------------------------
create or replace function public.get_recurring_sessions(
  p_filters jsonb default '{}'::jsonb,
  p_min_students integer default 2,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_summary jsonb;
begin
  perform private.require_role('analyst');
  p_min_students := greatest(coalesce(p_min_students, 2), 2);
  p_limit := least(greatest(coalesce(p_limit, 25), 1), 200);

  with s as (
    select e.session_ref, e.project_code,
      max(e.lesson_name) as lesson_name,
      count(*) as tickets,
      count(distinct e.owner_id) as students,
      count(*) filter (where e.is_open) as open_tickets,
      array_agg(distinct e.topic) as topics,
      min(e.created_at) as first_created_at,
      max(e.created_at) as last_created_at
    from private.enriched_tickets(p_filters) e
    where e.session_ref is not null
    group by e.session_ref, e.project_code
  )
  select
    coalesce((select jsonb_agg(to_jsonb(x) order by x.students desc, x.tickets desc, x.session_ref)
              from (select * from s where s.students >= p_min_students
                    order by s.students desc, s.tickets desc, s.session_ref limit p_limit) x), '[]'::jsonb),
    jsonb_build_object(
      'sessions_with_tickets', (select count(*) from s),
      'recurring_sessions', (select count(*) from s where s.students >= p_min_students),
      'tickets_in_recurring_sessions', (select coalesce(sum(s.tickets), 0) from s where s.students >= p_min_students),
      'min_students', p_min_students
    )
  into v, v_summary;

  return jsonb_build_object('summary', v_summary, 'sessions', v);
end;
$$;

-- -----------------------------------------------------------------------------
-- Ticket explorer
-- -----------------------------------------------------------------------------
create or replace function public.search_tickets(
  p_filters jsonb default '{}'::jsonb,
  p_search text default null,
  p_sort text default 'created_at',
  p_dir text default 'desc',
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := private.require_role('analyst');
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
    using coalesce(p_filters, '{}'::jsonb), v_like, v_id, v_search, (v_role = 'admin'),
          p_page_size, (p_page - 1) * p_page_size;

  return jsonb_build_object(
    'total', v_total,
    'page', p_page,
    'page_size', p_page_size,
    'sort', p_sort,
    'dir', v_dir,
    'content_search', (v_role = 'admin'),
    'rows', v_rows
  );
end;
$$;

-- Ticket detail. A source Ticket_ID may exist in more than one project (for
-- example an archived cycle and its replacement); pass the project code to pick
-- one, otherwise an ambiguous ID returns the candidates.
drop function if exists public.get_ticket_detail(bigint);
create function public.get_ticket_detail(p_ticket_id bigint, p_project_code text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role text := private.require_role('analyst');
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
    'content_visible', (v_role = 'admin'),
    'message', case when v_role = 'admin' then t.message end,
    'response', case when v_role = 'admin' then t.response end,
    'note', case when v_role = 'admin' then t.note end,
    'attachments', case when v_role = 'admin' then coalesce((
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
        'values', case when v_role = 'admin' then h.changes end,
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

  if v is not null and v_role = 'admin' then
    perform private.log_audit('ticket.view_content', jsonb_build_object('ticket_id', p_ticket_id, 'project', v ->> 'project_code'));
  end if;

  return v;
end;
$$;

-- Ticket export: keyset pagination on the internal key (source IDs may repeat across projects).
drop function if exists public.export_tickets_page(jsonb, bigint, integer, boolean);
create function public.export_tickets_page(
  p_filters jsonb default '{}'::jsonb,
  p_after_pk bigint default 0,
  p_limit integer default 1000,
  p_include_text boolean default false
)
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

-- -----------------------------------------------------------------------------
-- Data quality (scoped) with import health, unmapped topics, unclassified statuses
-- -----------------------------------------------------------------------------
create or replace function public.get_data_quality(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_missing jsonb;
  v_consistency jsonb;
  v_bulk jsonb;
  v_kinds jsonb;
  v_import_errors jsonb;
  v_coverage jsonb;
  v_reconciliation jsonb;
  v_total bigint;
  v_f jsonb;
  v_repeats jsonb;
  v_unmapped jsonb;
  v_statuses jsonb;
  v_jobs jsonb;
  v_cross_project bigint;
begin
  perform private.require_role('analyst');
  v_f := coalesce(p_filters, '{}'::jsonb);

  select count(*) into v_total from private.filtered_tickets(v_f);

  select jsonb_build_array(
    jsonb_build_object('field', 'Ticket_ID', 'missing', 0),
    jsonb_build_object('field', 'Topic', 'missing', count(*) filter (where topic is null)),
    jsonb_build_object('field', 'Message', 'missing', count(*) filter (where message is null)),
    jsonb_build_object('field', 'Status', 'missing', count(*) filter (where status is null)),
    jsonb_build_object('field', 'Priority', 'missing', count(*) filter (where priority is null)),
    jsonb_build_object('field', 'Department', 'missing', count(*) filter (where department is null)),
    jsonb_build_object('field', 'Owner_Type', 'missing', count(*) filter (where owner_type is null)),
    jsonb_build_object('field', 'Owner_ID', 'missing', count(*) filter (where owner_id is null)),
    jsonb_build_object('field', 'Affected_Student_ID', 'missing', count(*) filter (where affected_student_id is null)),
    jsonb_build_object('field', 'Created_At', 'missing', 0),
    jsonb_build_object('field', 'Responded_At', 'missing', count(*) filter (where responded_at is null)),
    jsonb_build_object('field', 'Resolved_At', 'missing', count(*) filter (where resolved_at is null)),
    jsonb_build_object('field', 'Response', 'missing', count(*) filter (where response is null)),
    jsonb_build_object('field', 'Note', 'missing', count(*) filter (where note is null)),
    jsonb_build_object('field', 'Responder_Name', 'missing', count(*) filter (where responder_name is null)),
    jsonb_build_object('field', 'Resolved_By', 'missing', count(*) filter (where resolved_by is null)),
    jsonb_build_object('field', 'Organization_ID', 'missing', 0),
    jsonb_build_object('field', 'Attachment_URLs', 'missing', count(*) filter (where attachment_urls is null)),
    jsonb_build_object('field', 'Response_Attachment_URLs', 'missing', count(*) filter (where response_attachment_urls is null))
  ) into v_missing
  from private.filtered_tickets(v_f);

  select jsonb_build_object(
    'missing_status', count(*) filter (where status is null),
    'completed_without_resolved_at', count(*) filter (where status = 'completed' and resolved_at is null),
    'completed_without_responded_at', count(*) filter (where status = 'completed' and responded_at is null),
    'pending_with_resolved_at', count(*) filter (where status = 'pending' and resolved_at is not null),
    'rejected_with_resolved_at', count(*) filter (where status = 'rejected' and resolved_at is not null),
    'resolved_before_responded', count(*) filter (where resolved_at < responded_at),
    'responded_before_created', count(*) filter (where responded_at < created_at),
    'resolved_before_created', count(*) filter (where resolved_at < created_at),
    'responded_equals_resolved', count(*) filter (where responded_at = resolved_at),
    'responder_differs_from_resolver', count(*) filter (where responder_name is not null and resolved_by is not null
                                                         and responder_name <> resolved_by),
    'missing_responded_at', count(*) filter (where responded_at is null),
    'missing_resolved_at', count(*) filter (where resolved_at is null),
    'priority_all_empty', (count(*) filter (where priority is not null) = 0),
    'affected_student_all_empty', (count(*) filter (where affected_student_id is not null) = 0)
  ) into v_consistency
  from private.filtered_tickets(v_f);

  select coalesce(jsonb_agg(to_jsonb(x) order by x.tickets desc), '[]'::jsonb)
    into v_bulk
  from (
    select t.resolved_at, t.resolved_by, count(*) as tickets
    from private.filtered_tickets(v_f) t
    where t.resolved_at is not null
    group by t.resolved_at, t.resolved_by
    having count(*) >= 10
    order by count(*) desc
    limit 25
  ) x;

  select jsonb_build_object(
    'same_session_groups', count(*) filter (where x.kind = 'session'),
    'same_session_tickets', coalesce(sum(x.n) filter (where x.kind = 'session'), 0),
    'same_day_topic_groups', count(*) filter (where x.kind = 'day'),
    'same_day_topic_tickets', coalesce(sum(x.n) filter (where x.kind = 'day'), 0)
  ) into v_repeats
  from (
    select 'session' as kind, count(*) as n
    from private.filtered_tickets(v_f) t
    where t.session_ref is not null and t.owner_id is not null
    group by t.owner_id, t.session_ref, t.topic
    having count(*) > 1
    union all
    select 'day' as kind, count(*) as n
    from private.filtered_tickets(v_f) t
    where t.owner_id is not null
    group by t.owner_id, t.topic, t.created_date
    having count(*) > 1
  ) x;

  select coalesce(jsonb_object_agg(x.k, x.n), '{}'::jsonb)
    into v_kinds
  from (select response_kind k, count(*) n from private.filtered_tickets(v_f) group by 1) x;

  select coalesce(jsonb_agg(jsonb_build_object('error_code', x.error_code, 'count', x.n) order by x.n desc), '[]'::jsonb)
    into v_import_errors
  from (
    select e.error_code, count(*) n
    from public.import_errors e
    join public.import_runs r on r.id = e.import_run_id
    join private.scope_projects(v_f) p on p.id = r.project_id
    group by 1
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'project', c.code, 'name', c.name, 'status', c.status, 'display_order', c.display_order,
           'tickets', coalesce(f.n, 0), 'first_date', f.first_date, 'last_date', f.last_date,
           'active_days', coalesce(f.active_days, 0), 'snapshot_at', c.snapshot_at,
           'last_complete_date', c.last_complete_date) order by c.display_order), '[]'::jsonb)
    into v_coverage
  from private.project_coverage(v_f) c
  left join (
    select t.project_id, count(*) n, min(t.created_date) first_date, max(t.created_date) last_date,
           count(distinct t.created_date) active_days
    from private.filtered_tickets(v_f) t group by 1
  ) f on f.project_id = c.project_id;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.source_filename), '[]'::jsonb)
    into v_reconciliation
  from (
    select distinct on (r.project_id, r.source_filename)
      r.id as import_run_id, r.source_filename, p.code as project, r.file_hash, r.completed_at,
      r.status, r.source, r.records_in_file, r.inserted_count, r.updated_count, r.skipped_count,
      r.rejected_count, r.reconciliation,
      (select count(*) from public.tickets t where t.project_id = r.project_id) as db_project_tickets,
      (select count(*) from public.tickets t where t.project_id = r.project_id
          and t.source_filename = r.source_filename) as db_tickets_from_file
    from public.import_runs r
    join private.scope_projects(v_f) p on p.id = r.project_id
    where r.status in ('completed', 'completed_with_errors')
    order by r.project_id, r.source_filename, r.completed_at desc
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('topic', x.topic, 'tickets', x.n) order by x.n desc), '[]'::jsonb)
    into v_unmapped
  from (
    select t.topic, count(*) n from private.filtered_tickets(v_f) t
    where not exists (select 1 from public.topic_categories m where m.topic = t.topic)
    group by 1
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('status', x.status, 'tickets', x.n) order by x.n desc), '[]'::jsonb)
    into v_statuses
  from (
    select t.status, count(*) n from private.filtered_tickets(v_f) t
    where not exists (select 1 from public.ticket_statuses st where st.status = coalesce(t.status, '__none__'))
    group by 1
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', j.id, 'project', p.code, 'status', j.status, 'original_filename', j.original_filename,
           'rows_applied', j.rows_applied, 'rows_to_apply', j.rows_to_apply, 'rows_invalid', j.rows_invalid,
           'error_code', j.error_code, 'updated_at', j.updated_at) order by j.updated_at desc), '[]'::jsonb)
    into v_jobs
  from public.import_jobs j
  join private.scope_projects(v_f) p on p.id = j.project_id
  where j.status in ('importing', 'failed', 'completed_with_errors')
    and j.updated_at > now() - interval '90 days';

  -- Source IDs that occur in more than one project of the scope.
  select count(*) into v_cross_project
  from (select t.ticket_id from private.filtered_tickets(v_f) t group by t.ticket_id having count(distinct t.project_id) > 1) d;

  return jsonb_build_object(
    'total', v_total,
    'missing_by_field', v_missing,
    'consistency', v_consistency,
    'bulk_resolution_events', v_bulk,
    'repeat_submissions', v_repeats,
    'response_kinds', v_kinds,
    'import_errors', v_import_errors,
    'duplicate_ticket_ids_in_db', v_cross_project,
    'coverage', v_coverage,
    'reconciliation', v_reconciliation,
    'unmapped_topics', v_unmapped,
    'unclassified_statuses', v_statuses,
    'import_jobs', v_jobs
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Import history (CLI runs and web jobs)
-- -----------------------------------------------------------------------------
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
  ) x;

  if v_run is null then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'source_row_number', e.source_row_number, 'ticket_id', e.ticket_id,
           'error_code', e.error_code, 'validation_error', e.validation_error,
           'raw_row', case when v_role = 'admin' then e.raw_row end,
           'recorded_at', e.recorded_at) order by e.source_row_number nulls first, e.id), '[]'::jsonb)
    into v_errors
  from (select * from public.import_errors e2 where e2.import_run_id = p_run_id order by e2.id limit 1000) e;

  return jsonb_build_object('run', v_run, 'errors', v_errors, 'raw_rows_visible', v_role = 'admin');
end;
$$;

-- -----------------------------------------------------------------------------
-- Settings
-- -----------------------------------------------------------------------------
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
  v_admin := private.is_admin();
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
        'projects', (select count(*) from public.projects p where p.cycle_id = rc.id and p.status <> 'draft'))
        order by rc.is_current desc, (rc.status = 'archived'), rc.display_order, rc.created_at desc)
      from public.reporting_cycles rc where rc.status <> 'draft' or v_admin), '[]'::jsonb),
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
      where p.status <> 'draft' or v_admin), '[]'::jsonb)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Function privileges
-- -----------------------------------------------------------------------------
revoke all on function public.get_scope_catalog() from public, anon;
revoke all on function public.get_filter_options(jsonb) from public, anon;
revoke all on function public.get_ticket_detail(bigint, text) from public, anon;
revoke all on function public.export_tickets_page(jsonb, bigint, integer, boolean) from public, anon;
revoke all on all functions in schema private from public, anon;

grant execute on function
  public.get_scope_catalog(),
  public.get_filter_options(jsonb),
  public.get_ticket_detail(bigint, text),
  public.export_tickets_page(jsonb, bigint, integer, boolean)
to authenticated;

grant execute on function private.current_app_role() to authenticated;
grant execute on function private.has_app_access() to authenticated;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.require_role(text) to authenticated;
