-- An outdated screen is a business conflict. Return HTTP 409 from PostgREST
-- instead of exposing a serialization error to the HTTP gateway.
begin;

create or replace function public.transition_task(
  p_task_id uuid, p_expected_status public.task_status, p_to_status public.task_status, p_comment text default null
)
returns uuid language plpgsql security invoker set search_path = ''
as $$
begin
  return private.transition_task(p_task_id, p_expected_status, p_to_status, p_comment);
exception when serialization_failure then
  if sqlerrm = 'stale_status_refresh_required' then
    raise sqlstate 'PT409' using message = 'stale_status_refresh_required';
  end if;
  raise;
end;
$$;

commit;
