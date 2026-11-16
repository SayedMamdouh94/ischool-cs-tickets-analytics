-- =============================================================================
-- Cheaper import confirmation for large files.
--
-- Confirming used to recompute the whole preview (seconds for 100,000 rows,
-- under the 8 s limit of signed-in requests). The preview now records a small
-- fingerprint of everything that can change it — imports (CLI or web), project
-- lifecycle changes and the target project's ticket count — and confirmation
-- recomputes only when that fingerprint changed. Correctness does not depend on
-- it: every batch re-checks each row against the live database when applied.
-- =============================================================================

alter table public.import_jobs add column if not exists preview_basis text;

create or replace function private.import_preview_basis(p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select concat_ws('|',
    (select count(*) from public.import_runs),
    (select max(coalesce(r.completed_at, r.started_at)) from public.import_runs r),
    (select max(p.updated_at) from public.projects p),
    (select count(*) from public.tickets t where t.project_id = p_project_id));
$$;

revoke all on function private.import_preview_basis(uuid) from public, anon, authenticated;

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
         preview_basis = private.import_preview_basis(v_job.project_id),
         rows_valid = (v_counts ->> 'valid')::int, rows_invalid = (v_counts ->> 'invalid')::int,
         warnings_count = (select count(*) from public.import_job_issues i where i.job_id = p_job_id and i.severity = 'warning')
   where id = p_job_id;
  return v_preview;
end;
$$;

-- Confirms a validated job: checks the preview is still current (recomputing it
-- only when the underlying data changed; refusing if the counts moved), creates the draft project/cycle when starting
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

