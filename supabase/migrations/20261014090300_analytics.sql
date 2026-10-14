-- =============================================================================
-- CS Tickets Analytics — analytical functions
--
-- Every public function:
--   * is SECURITY DEFINER with an empty search_path and fully-qualified names,
--   * calls private.require_role(...) as its first statement,
--   * is executable by `authenticated` only (never `anon`),
--   * returns a single jsonb value (not subject to PostgREST row limits),
--   * computes statistics in the database from current data (nothing hardcoded).
--
-- Filters are passed as one jsonb object (validated server-side with Zod):
--   projects, programs, intakes, statuses, topics, responders, resolvers,
--   categories, subcategories, response_kinds  -> arrays of text
--   date_from, date_to                         -> 'YYYY-MM-DD' (Africa/Cairo calendar, inclusive)
--   session_ref, lesson                        -> text
-- The token '__none__' matches NULL values for statuses/responders/resolvers.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Filtering primitives
-- -----------------------------------------------------------------------------
create or replace function private.jarr(j jsonb)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when jsonb_typeof(j) = 'array' and jsonb_array_length(j) > 0
      then array(select jsonb_array_elements_text(j))
  end;
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
      private.jarr(f -> 'projects')       as projects,
      private.jarr(f -> 'programs')       as programs,
      private.jarr(f -> 'intakes')        as intakes,
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
  )
  select t.*
  from public.tickets t
  join public.projects p on p.id = t.project_id
  cross join fx
  where (fx.projects is null or p.code = any (fx.projects))
    and (fx.programs is null or p.program = any (fx.programs))
    and (fx.intakes is null or p.intake = any (fx.intakes))
    and (fx.date_from is null or t.created_date >= fx.date_from)
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
          where c.ticket_id = t.ticket_id and c.is_current and k.code = any (fx.categories)))
    and (fx.subcategories is null or exists (
          select 1
          from public.ticket_classifications c
          join public.ticket_categories k on k.id = c.subcategory_id
          where c.ticket_id = t.ticket_id and c.is_current and k.code = any (fx.subcategories)));
$$;

-- Latest export snapshot per project: the data_as_of of the newest successful
-- import, falling back to the latest timestamp present in the data.
create or replace view private.project_snapshots as
select
  p.id as project_id,
  coalesce(
    (select max(r.data_as_of)
       from public.import_runs r
      where r.project_id = p.id and r.status in ('completed', 'completed_with_errors')),
    (select max(greatest(t.created_at, t.responded_at, t.resolved_at))
       from public.tickets t
      where t.project_id = p.id)
  ) as snapshot_at
from public.projects p;

create or replace function private.threshold_seconds(p_key text)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select th.value_hours * 3600 from public.analytics_thresholds th where th.key = p_key),
    case p_key when 'response_hours' then 24 * 3600 else 72 * 3600 end
  );
$$;

-- Tickets enriched with project and current classification (internal).
create or replace function private.enriched_tickets(f jsonb)
returns table (
  ticket_id bigint,
  project_id uuid,
  project_code text,
  project_name text,
  program text,
  intake text,
  intake_group text,
  topic text,
  status text,
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
    t.ticket_id, t.project_id, p.code, p.name, p.program, p.intake, p.intake_group,
    t.topic, t.status, t.responder_name, t.resolved_by, t.owner_id, t.lesson_name,
    t.session_ref, t.response_kind, (t.note is not null),
    t.created_at, t.responded_at, t.resolved_at, t.created_date, t.created_hour,
    t.created_isodow, t.response_seconds, t.resolution_seconds,
    cat.code, cat.name_en, sub.code, sub.name_en, s.snapshot_at
  from private.filtered_tickets(f) t
  join public.projects p on p.id = t.project_id
  left join private.project_snapshots s on s.project_id = t.project_id
  left join public.ticket_classifications c on c.ticket_id = t.ticket_id and c.is_current
  left join public.ticket_categories cat on cat.id = c.category_id
  left join public.ticket_categories sub on sub.id = c.subcategory_id;
$$;

-- -----------------------------------------------------------------------------
-- Access context
-- -----------------------------------------------------------------------------
create or replace function public.get_my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', (select auth.uid()),
    'role', private.current_app_role()
  );
$$;

-- -----------------------------------------------------------------------------
-- Filter options and dataset coverage
-- -----------------------------------------------------------------------------
create or replace function public.get_filter_options()
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

  select jsonb_build_object(
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', p.code, 'name', p.name, 'program', p.program, 'intake', p.intake,
        'intake_group', p.intake_group, 'organization_id', p.organization_id,
        'is_active', p.is_active) order by p.display_order, p.code)
      from public.projects p), '[]'::jsonb),
    'programs', coalesce((select jsonb_agg(distinct p.program) from public.projects p), '[]'::jsonb),
    'intakes', coalesce((select jsonb_agg(distinct p.intake) from public.projects p), '[]'::jsonb),
    'statuses', coalesce((
      select jsonb_agg(jsonb_build_object('value', x.v, 'count', x.n) order by x.n desc)
      from (select coalesce(t.status, '__none__') v, count(*) n from public.tickets t group by 1) x), '[]'::jsonb),
    'topics', coalesce((
      select jsonb_agg(jsonb_build_object('value', x.v, 'count', x.n) order by x.n desc)
      from (select t.topic v, count(*) n from public.tickets t group by 1) x), '[]'::jsonb),
    'responders', coalesce((
      select jsonb_agg(jsonb_build_object('value', x.v, 'count', x.n) order by x.n desc)
      from (select coalesce(t.responder_name, '__none__') v, count(*) n from public.tickets t group by 1) x), '[]'::jsonb),
    'resolvers', coalesce((
      select jsonb_agg(jsonb_build_object('value', x.v, 'count', x.n) order by x.n desc)
      from (select coalesce(t.resolved_by, '__none__') v, count(*) n from public.tickets t group by 1) x), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('code', k.code, 'name', k.name_en, 'name_ar', k.name_ar,
                                          'kind', k.kind) order by k.kind, k.sort_order)
      from public.ticket_categories k where k.is_active), '[]'::jsonb),
    'date_range', (
      select jsonb_build_object('min', min(t.created_date), 'max', max(t.created_date),
                                'min_at', min(t.created_at), 'max_at', max(t.created_at))
      from public.tickets t),
    'latest_import', (
      select jsonb_build_object('completed_at', max(r.completed_at), 'data_as_of', max(r.data_as_of))
      from public.import_runs r where r.status in ('completed', 'completed_with_errors')),
    'total_tickets', (select count(*) from public.tickets)
  ) into v;

  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grouped metrics: the workhorse for KPIs, comparisons, topics and team pages.
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
      count(*) filter (where k.resolved_at is null and (k.status = 'pending' or k.status is null)) as open_tickets,
      count(k.responded_at) as with_response_ts,
      count(k.resolved_at) as with_resolution_ts,
      count(*) filter (where k.has_note) as with_note,
      count(*) filter (where k.response_kind = 'generic_acknowledgement') as generic_ack,
      count(distinct k.owner_id) as unique_owners,
      -- Recorded first response (responded_at - created_at)
      count(*) filter (where k.response_seconds >= 0) as response_n,
      count(*) filter (where k.response_seconds < 0) as response_invalid,
      round(avg(k.response_seconds) filter (where k.response_seconds >= 0)) as response_avg_s,
      round((percentile_cont(0.5) within group (order by k.response_seconds)
             filter (where k.response_seconds >= 0))::numeric) as response_median_s,
      round((percentile_cont(0.9) within group (order by k.response_seconds)
             filter (where k.response_seconds >= 0))::numeric) as response_p90_s,
      count(*) filter (where k.response_seconds > v_resp_th) as response_breaches,
      -- Resolution (resolved_at - created_at)
      count(*) filter (where k.resolution_seconds >= 0) as resolution_n,
      count(*) filter (where k.resolution_seconds < 0) as resolution_invalid,
      round(avg(k.resolution_seconds) filter (where k.resolution_seconds >= 0)) as resolution_avg_s,
      round((percentile_cont(0.5) within group (order by k.resolution_seconds)
             filter (where k.resolution_seconds >= 0))::numeric) as resolution_median_s,
      round((percentile_cont(0.9) within group (order by k.resolution_seconds)
             filter (where k.resolution_seconds >= 0))::numeric) as resolution_p90_s,
      count(*) filter (where k.resolution_seconds > v_res_th) as resolution_breaches,
      count(*) filter (where k.resolved_at is null and (k.status = 'pending' or k.status is null)
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
-- Cross tabulation (e.g. topic x project, responder x project)
-- -----------------------------------------------------------------------------
create or replace function public.get_cross_tab(
  p_filters jsonb default '{}'::jsonb,
  p_row_dimension text default 'topic',
  p_col_dimension text default 'project'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_dims text[] := array['project', 'program', 'intake', 'intake_group', 'topic', 'category',
                         'subcategory', 'responder', 'resolver', 'status', 'response_kind', 'month'];
begin
  perform private.require_role('analyst');
  if not (p_row_dimension = any (v_dims)) or not (p_col_dimension = any (v_dims)) then
    raise exception 'Unsupported dimension' using errcode = '22023';
  end if;

  with keyed as (
    select
      case d.dim
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
        when 'month' then to_char(e.created_date, 'YYYY-MM')
      end as val,
      d.axis,
      e.ticket_id,
      e.resolution_seconds
    from private.enriched_tickets(p_filters) e
    cross join (values ('r', p_row_dimension), ('c', p_col_dimension)) as d(axis, dim)
  ),
  pairs as (
    select r.val as row_key, c.val as col_key, r.ticket_id, r.resolution_seconds
    from keyed r
    join keyed c on c.ticket_id = r.ticket_id and c.axis = 'c'
    where r.axis = 'r'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'row', x.row_key, 'col', x.col_key, 'count', x.n,
           'resolution_median_s', x.med) order by x.row_key, x.col_key), '[]'::jsonb)
    into v
  from (
    select row_key, col_key, count(*) n,
           round((percentile_cont(0.5) within group (order by resolution_seconds)
                  filter (where resolution_seconds >= 0))::numeric) med
    from pairs
    group by row_key, col_key
  ) x;

  return jsonb_build_object('row_dimension', p_row_dimension, 'col_dimension', p_col_dimension, 'cells', v);
end;
$$;

-- -----------------------------------------------------------------------------
-- Volume over time
-- -----------------------------------------------------------------------------
create or replace function public.get_volume_series(
  p_filters jsonb default '{}'::jsonb,
  p_grain text default 'day',
  p_split text default 'none'
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
  perform private.require_role('analyst');
  if p_grain not in ('day', 'week', 'month') then
    raise exception 'Unsupported grain: %', p_grain using errcode = '22023';
  end if;
  if p_split not in ('none', 'project', 'program', 'intake_group', 'status', 'topic', 'category', 'subcategory') then
    raise exception 'Unsupported split: %', p_split using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('bucket', x.bucket, 'key', x.key, 'count', x.n)
                            order by x.bucket, x.key), '[]'::jsonb)
    into v
  from (
    select
      case p_grain
        when 'day' then e.created_date
        when 'week' then date_trunc('week', e.created_date)::date
        else date_trunc('month', e.created_date)::date
      end as bucket,
      case p_split
        when 'none' then 'all'
        when 'project' then e.project_code
        when 'program' then e.program
        when 'intake_group' then e.intake_group
        when 'status' then coalesce(e.status, '__none__')
        when 'topic' then e.topic
        when 'category' then coalesce(e.category_code, '__none__')
        when 'subcategory' then coalesce(e.subcategory_code, '__none__')
      end as key,
      count(*) as n
    from private.enriched_tickets(p_filters) e
    group by 1, 2
  ) x;

  return jsonb_build_object('grain', p_grain, 'split', p_split, 'points', v);
end;
$$;

create or replace function public.get_weekday_hour(p_filters jsonb default '{}'::jsonb)
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
  select coalesce(jsonb_agg(jsonb_build_object('isodow', x.d, 'hour', x.h, 'count', x.n)
                            order by x.d, x.h), '[]'::jsonb)
    into v
  from (
    select e.created_isodow d, e.created_hour h, count(*) n
    from private.enriched_tickets(p_filters) e
    group by 1, 2
  ) x;
  return jsonb_build_object('timezone', 'Africa/Cairo', 'cells', v);
end;
$$;

-- -----------------------------------------------------------------------------
-- Duration distribution
-- -----------------------------------------------------------------------------
create or replace function public.get_duration_histogram(
  p_filters jsonb default '{}'::jsonb,
  p_metric text default 'resolution',
  p_split text default 'none'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_excluded jsonb;
begin
  perform private.require_role('analyst');
  if p_metric not in ('response', 'resolution') then
    raise exception 'Unsupported metric: %', p_metric using errcode = '22023';
  end if;
  if p_split not in ('none', 'project', 'program', 'intake_group') then
    raise exception 'Unsupported split: %', p_split using errcode = '22023';
  end if;

  with d as (
    select
      case p_metric when 'response' then e.response_seconds else e.resolution_seconds end as s,
      case p_split
        when 'none' then 'all'
        when 'project' then e.project_code
        when 'program' then e.program
        when 'intake_group' then e.intake_group
      end as key
    from private.enriched_tickets(p_filters) e
  ),
  b as (
    select key,
      case
        when s < 3600 then 0
        when s < 4 * 3600 then 1
        when s < 24 * 3600 then 2
        when s < 72 * 3600 then 3
        when s < 168 * 3600 then 4
        when s < 336 * 3600 then 5
        when s < 720 * 3600 then 6
        else 7
      end as bucket
    from d
    where s >= 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('bucket', x.bucket, 'key', x.key, 'count', x.n)
                            order by x.bucket, x.key), '[]'::jsonb)
    into v
  from (select bucket, key, count(*) n from b group by 1, 2) x;

  select jsonb_build_object(
    'missing', count(*) filter (where s is null),
    'negative', count(*) filter (where s < 0)
  ) into v_excluded
  from (
    select case p_metric when 'response' then e.response_seconds else e.resolution_seconds end as s
    from private.enriched_tickets(p_filters) e
  ) z;

  return jsonb_build_object(
    'metric', p_metric,
    'split', p_split,
    'bucket_edges_hours', jsonb_build_array(0, 1, 4, 24, 72, 168, 336, 720),
    'bins', v,
    'excluded', v_excluded
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Backlog (current imported status) and reconstructed historical backlog
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
begin
  perform private.require_role('analyst');
  p_oldest_limit := least(greatest(coalesce(p_oldest_limit, 25), 1), 200);

  -- Open = current imported status is pending or missing (no status), with no resolution timestamp.
  with o as (
    select e.*, extract(epoch from (e.snapshot_at - e.created_at)) as age_s
    from private.enriched_tickets(p_filters) e
    where e.resolved_at is null and (e.status = 'pending' or e.status is null)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'project', x.project_code, 'status', x.status, 'age_bucket', x.bucket, 'count', x.n)
           order by x.project_code, x.bucket), '[]'::jsonb)
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
    where e.resolved_at is null and (e.status = 'pending' or e.status is null)
    order by e.snapshot_at - e.created_at desc
    limit p_oldest_limit
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('topic', x.topic, 'count', x.n) order by x.n desc), '[]'::jsonb)
    into v_topics
  from (
    select e.topic, count(*) n
    from private.enriched_tickets(p_filters) e
    where e.resolved_at is null and (e.status = 'pending' or e.status is null)
    group by 1
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('project', p.code, 'snapshot_at', s.snapshot_at)
                            order by p.display_order), '[]'::jsonb)
    into v_snapshots
  from public.projects p
  join private.project_snapshots s on s.project_id = p.id;

  -- Reconstructed from timestamps only: open(D) = created on/before D minus
  -- resolved on/before D. Tickets with no resolution timestamp (pending,
  -- rejected, missing) are excluded because their closure time is unknown.
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
    'reconstructed', v_reconstructed
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Period-over-period comparison
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
  v_to date;
  v_from date;
  v_len integer;
  v_prev_from date;
  v_prev_to date;
  v_base jsonb;
  v_rows jsonb;
begin
  perform private.require_role('analyst');
  if p_dimension not in ('none', 'project', 'program', 'topic', 'category', 'subcategory') then
    raise exception 'Unsupported dimension: %', p_dimension using errcode = '22023';
  end if;

  -- Base filter without dates; the period is applied explicitly below.
  v_base := coalesce(p_filters, '{}'::jsonb) - 'date_from' - 'date_to';

  v_to := coalesce(nullif(p_filters ->> 'date_to', '')::date,
                   (select max(t.created_date) from private.filtered_tickets(v_base) t));
  if v_to is null then
    return jsonb_build_object('current', null, 'previous', null, 'rows', '[]'::jsonb);
  end if;

  if p_days is not null then
    v_len := least(greatest(p_days, 1), 366);
    v_from := v_to - (v_len - 1);
  else
    v_from := coalesce(nullif(p_filters ->> 'date_from', '')::date, v_to - 29);
    v_len := (v_to - v_from) + 1;
  end if;
  v_prev_to := v_from - 1;
  v_prev_from := v_prev_to - (v_len - 1);

  select coalesce(jsonb_agg(jsonb_build_object('key', x.key, 'label', x.label,
                                               'current', x.cur, 'previous', x.prev)
                            order by x.cur desc, x.key), '[]'::jsonb)
    into v_rows
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
      count(*) filter (where e.created_date between v_from and v_to) as cur,
      count(*) filter (where e.created_date between v_prev_from and v_prev_to) as prev
    from private.enriched_tickets(v_base) e
    where e.created_date between v_prev_from and v_to
    group by 1
  ) x;

  return jsonb_build_object(
    'dimension', p_dimension,
    'current', jsonb_build_object('from', v_from, 'to', v_to, 'days', v_len),
    'previous', jsonb_build_object('from', v_prev_from, 'to', v_prev_to, 'days', v_len),
    'rows', v_rows
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Recurring problems: the same session reported by several tickets
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
      count(*) filter (where e.resolved_at is null and (e.status = 'pending' or e.status is null)) as open_tickets,
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
-- Ticket explorer (server-side pagination, sorting, filtering)
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

  -- Only administrators may search inside free-text content.
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
          select row_number() over (order by %1$s %2$s nulls last, t.ticket_id %2$s) as ord,
            jsonb_build_object(
              'ticket_id', t.ticket_id,
              'project_code', p.code,
              'project_name', p.name,
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
          left join public.ticket_classifications c on c.ticket_id = t.ticket_id and c.is_current
          left join public.ticket_categories cat on cat.id = c.category_id
          left join public.ticket_categories sub on sub.id = c.subcategory_id
          order by %1$s %2$s nulls last, t.ticket_id %2$s
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

-- Ticket detail. Raw content (message, response, note, attachments) is only
-- returned to administrators, and each such access is audited.
create or replace function public.get_ticket_detail(p_ticket_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role text := private.require_role('analyst');
  v jsonb;
begin
  select jsonb_build_object(
    'ticket_id', t.ticket_id,
    'project_code', p.code,
    'project_name', p.name,
    'organization_id', t.organization_id,
    'topic', t.topic,
    'status', t.status,
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
      from public.ticket_attachments a where a.ticket_id = t.ticket_id), '[]'::jsonb) end,
    'attachment_count', (select count(*) from public.ticket_attachments a where a.ticket_id = t.ticket_id)
  )
  into v
  from public.tickets t
  join public.projects p on p.id = t.project_id
  left join public.ticket_classifications c on c.ticket_id = t.ticket_id and c.is_current
  left join public.ticket_categories cat on cat.id = c.category_id
  left join public.ticket_categories sub on sub.id = c.subcategory_id
  where t.ticket_id = p_ticket_id;

  if v is not null and v_role = 'admin' then
    perform private.log_audit('ticket.view_content', jsonb_build_object('ticket_id', p_ticket_id));
  end if;

  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Exports (admin only for ticket-level rows; keyset pagination)
-- -----------------------------------------------------------------------------
create or replace function public.export_tickets_page(
  p_filters jsonb default '{}'::jsonb,
  p_after_ticket_id bigint default 0,
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

  select coalesce(jsonb_agg(x.j order by x.ticket_id), '[]'::jsonb)
    into v
  from (
    select t.ticket_id, jsonb_build_object(
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
    left join public.ticket_classifications c on c.ticket_id = t.ticket_id and c.is_current
    left join public.ticket_categories cat on cat.id = c.category_id
    left join public.ticket_categories sub on sub.id = c.subcategory_id
    where t.ticket_id > coalesce(p_after_ticket_id, 0)
    order by t.ticket_id
    limit p_limit
  ) x;

  return v;
end;
$$;

create or replace function public.record_export(p_kind text, p_filters jsonb, p_row_count integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_kind like 'tickets%' then
    perform private.require_role('admin');
  else
    perform private.require_role('analyst');
  end if;
  if p_kind !~ '^[a-z][a-z0-9_]{1,60}$' then
    raise exception 'Invalid export kind' using errcode = '22023';
  end if;
  perform private.log_audit('export.' || p_kind,
    jsonb_build_object('filters', coalesce(p_filters, '{}'::jsonb), 'rows', p_row_count));
end;
$$;

-- -----------------------------------------------------------------------------
-- Data quality
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
  from (select e.error_code, count(*) n from public.import_errors e group by 1) x;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.display_order), '[]'::jsonb)
    into v_coverage
  from (
    select p.code as project, p.name, p.display_order,
      count(t.ticket_id) as tickets,
      min(t.created_date) as first_date,
      max(t.created_date) as last_date,
      count(distinct t.created_date) as active_days,
      s.snapshot_at
    from public.projects p
    left join private.filtered_tickets(v_f) t on t.project_id = p.id
    left join private.project_snapshots s on s.project_id = p.id
    group by p.code, p.name, p.display_order, s.snapshot_at
  ) x;

  -- File-level reconciliation: latest successful run per file vs. database now.
  select coalesce(jsonb_agg(to_jsonb(x) order by x.source_filename), '[]'::jsonb)
    into v_reconciliation
  from (
    select distinct on (r.source_filename)
      r.id as import_run_id, r.source_filename, p.code as project, r.file_hash, r.completed_at,
      r.status, r.records_in_file, r.inserted_count, r.updated_count, r.skipped_count,
      r.rejected_count, r.reconciliation,
      (select count(*) from public.tickets t where t.project_id = r.project_id) as db_project_tickets,
      (select count(*) from public.tickets t where t.project_id = r.project_id
          and t.source_filename = r.source_filename) as db_tickets_from_file
    from public.import_runs r
    left join public.projects p on p.id = r.project_id
    where r.status in ('completed', 'completed_with_errors')
    order by r.source_filename, r.completed_at desc
  ) x;

  return jsonb_build_object(
    'total', v_total,
    'missing_by_field', v_missing,
    'consistency', v_consistency,
    'bulk_resolution_events', v_bulk,
    'repeat_submissions', v_repeats,
    'response_kinds', v_kinds,
    'import_errors', v_import_errors,
    'duplicate_ticket_ids_in_db', (select count(*) - count(distinct ticket_id) from public.tickets),
    'coverage', v_coverage,
    'reconciliation', v_reconciliation
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Import history
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
    select r.id, r.source_filename, p.code as project, p.name as project_name, r.file_hash,
      r.file_size_bytes, r.started_at, r.completed_at, r.status, r.records_in_file,
      r.inserted_count, r.updated_count, r.skipped_unchanged_count, r.skipped_stale_count,
      r.skipped_count, r.rejected_count, r.data_as_of, r.min_created_at, r.max_created_at,
      r.duplicate_of_run_id, r.update_policy, r.importer_version, r.error_summary
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
    select r.*, p.code as project, p.name as project_name
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
-- Settings and access management (admin only, audited)
-- -----------------------------------------------------------------------------
create or replace function public.get_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role('analyst');
  return jsonb_build_object(
    'thresholds', coalesce((select jsonb_agg(to_jsonb(th) order by th.key) from public.analytics_thresholds th), '[]'::jsonb),
    'app', coalesce((select jsonb_object_agg(s.key, s.value) from public.app_settings s), '{}'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'code', p.code, 'name', p.name, 'program', p.program, 'intake', p.intake,
        'intake_group', p.intake_group, 'organization_id', p.organization_id,
        'file_name_hint', p.file_name_hint, 'display_order', p.display_order, 'is_active', p.is_active,
        'tickets', (select count(*) from public.tickets t where t.project_id = p.id))
        order by p.display_order)
      from public.projects p), '[]'::jsonb)
  );
end;
$$;

create or replace function public.update_threshold(p_key text, p_value_hours numeric)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old numeric;
begin
  perform private.require_role('admin');
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
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_role('admin');
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

create or replace function public.update_project(
  p_code text,
  p_name text,
  p_display_order smallint,
  p_is_active boolean,
  p_file_name_hint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_role('admin');
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception 'Invalid project name' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_file_name_hint, ''))) not between 1 and 120 then
    raise exception 'Invalid file name hint' using errcode = '22023';
  end if;
  update public.projects
     set name = btrim(p_name),
         display_order = coalesce(p_display_order, display_order),
         is_active = coalesce(p_is_active, is_active),
         file_name_hint = btrim(p_file_name_hint)
   where code = p_code;
  if not found then
    raise exception 'Unknown project %', p_code using errcode = '22023';
  end if;
  perform private.log_audit('settings.project_update',
    jsonb_build_object('code', p_code, 'name', btrim(p_name), 'is_active', p_is_active));
  return jsonb_build_object('code', p_code);
end;
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
    select u.id as user_id, u.email::text as email, ur.role, u.created_at, u.last_sign_in_at,
      u.email_confirmed_at, u.invited_at
    from auth.users u
    left join public.user_roles ur on ur.user_id = u.id
    where u.deleted_at is null
  ) x;
  return v;
end;
$$;

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
  if p_role not in ('admin', 'analyst') then
    raise exception 'Invalid role' using errcode = '22023';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email)) and u.deleted_at is null;
  if v_user is null then
    raise exception 'No user with that email exists. Invite the user first.' using errcode = '22023';
  end if;
  insert into public.user_roles (user_id, role, granted_by)
  values (v_user, p_role, (select auth.uid()))
  on conflict (user_id) do update set role = excluded.role, granted_by = excluded.granted_by;
  perform private.log_audit('access.role_granted', jsonb_build_object('user_id', v_user, 'role', p_role));
  return jsonb_build_object('user_id', v_user, 'role', p_role);
end;
$$;

create or replace function public.revoke_user_role(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_role('admin');
  delete from public.user_roles where user_id = p_user_id;
  perform private.log_audit('access.role_revoked', jsonb_build_object('user_id', p_user_id));
  return jsonb_build_object('user_id', p_user_id, 'revoked', true);
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
  perform private.require_role('admin');
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

-- -----------------------------------------------------------------------------
-- Function privileges: authenticated only; never anon/public.
-- -----------------------------------------------------------------------------
revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon;

grant execute on function
  public.get_my_access(),
  public.get_filter_options(),
  public.get_grouped_metrics(jsonb, text, integer),
  public.get_cross_tab(jsonb, text, text),
  public.get_volume_series(jsonb, text, text),
  public.get_weekday_hour(jsonb),
  public.get_duration_histogram(jsonb, text, text),
  public.get_backlog(jsonb, integer),
  public.get_period_comparison(jsonb, text, integer),
  public.get_recurring_sessions(jsonb, integer, integer),
  public.search_tickets(jsonb, text, text, text, integer, integer),
  public.get_ticket_detail(bigint),
  public.export_tickets_page(jsonb, bigint, integer, boolean),
  public.record_export(text, jsonb, integer),
  public.get_data_quality(jsonb),
  public.get_import_runs(integer),
  public.get_import_run_detail(uuid),
  public.get_settings(),
  public.update_threshold(text, numeric),
  public.update_app_setting(text, jsonb),
  public.update_project(text, text, smallint, boolean, text),
  public.list_app_users(),
  public.set_user_role(text, text),
  public.revoke_user_role(uuid),
  public.get_audit_events(integer)
to authenticated;

-- Helpers used inside RLS policies must stay executable by authenticated.
grant execute on function private.current_app_role() to authenticated;
grant execute on function private.has_app_access() to authenticated;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.require_role(text) to authenticated;
