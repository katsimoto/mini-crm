-- Existing cards start at revision 1. Only a successful status transition advances it.
begin;

alter table public.tasks add column status_revision integer not null default 1;

-- Remove the old write path so clients cannot omit the revision check.
drop function public.transition_task(uuid, public.task_status, public.task_status, text);
drop function private.transition_task(uuid, public.task_status, public.task_status, text);

create function private.transition_task(
  p_task_id uuid, p_expected_status public.task_status, p_expected_revision integer,
  p_to_status public.task_status, p_comment text default null
)
returns uuid language plpgsql security definer set search_path = ''
as $$ declare
  v_task public.tasks%rowtype; v_actor uuid := auth.uid(); v_role public.app_role;
  v_actor_name text; v_comment text; v_allowed boolean := false; v_now timestamptz;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'authentication_required'; end if;
  v_role := private.request_role();
  select * into v_task from public.tasks t
    where t.id = p_task_id and t.deleted_at is null and
      (v_role = 'manager' or (v_role = 'executor' and t.assignee_id = v_actor)) for update;
  -- A foreign or missing task produces the same error; no data is returned.
  if not found or v_role is null or
     (v_role = 'executor' and v_task.assignee_id is distinct from v_actor) then
    raise exception using errcode = '42501', message = 'task_unavailable';
  end if;
  if v_task.status is distinct from p_expected_status or
     v_task.status_revision is distinct from p_expected_revision then
    raise exception using errcode = 'PT409', message = 'stale_status_refresh_required';
  end if;
  if v_role = 'executor' then
    v_allowed := (v_task.status in ('new', 'rework') and p_to_status = 'in_progress') or
                 (v_task.status = 'in_progress' and p_to_status = 'in_review');
  elsif v_role = 'manager' then
    v_allowed := v_task.status = 'in_review' and p_to_status in ('accepted', 'rework');
  end if;
  if v_allowed is not true then
    raise exception using errcode = '22023', message = 'invalid_status_transition';
  end if;
  v_comment := nullif(btrim(p_comment, E' \t\n\r\f\013' ||
    U&'\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '');
  if p_to_status = 'rework' and (v_comment is null or v_comment !~ '[^[:space:]]') then
    raise exception using errcode = '22023', message = 'rework_comment_required';
  end if;
  if char_length(v_comment) > 2000 then
    raise exception using errcode = '22023', message = 'comment_too_long';
  end if;
  select p.display_name into v_actor_name from public.profiles p where p.id = v_actor;
  v_now := clock_timestamp();
  update public.tasks set status = p_to_status, status_revision = v_task.status_revision + 1, updated_at = v_now where id = p_task_id;
  insert into public.task_status_history(task_id, actor_id, actor_name, changed_at, from_status, to_status, comment)
    values (p_task_id, v_actor, v_actor_name, v_now, v_task.status, p_to_status, v_comment);
  -- Both statements commit together. A failed insert rolls back the status update.
  return p_task_id;
end $$;

create function public.transition_task(
  p_task_id uuid, p_expected_status public.task_status, p_expected_revision integer,
  p_to_status public.task_status, p_comment text default null
)
returns uuid language sql security invoker set search_path = ''
as $$
  select private.transition_task(p_task_id, p_expected_status, p_expected_revision, p_to_status, p_comment)
$$;

revoke all on function public.transition_task(uuid, public.task_status, integer, public.task_status, text),
  private.transition_task(uuid, public.task_status, integer, public.task_status, text)
  from public, anon, authenticated;
grant execute on function public.transition_task(uuid, public.task_status, integer, public.task_status, text),
  private.transition_task(uuid, public.task_status, integer, public.task_status, text)
  to authenticated;

notify pgrst, 'reload schema';
commit;
