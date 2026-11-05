-- Dedicated Supabase project. Run as the migration owner (normally postgres).
-- Read access is governed by RLS. Writes are possible only through the RPCs below.
-- Keep the private schema OUT of Supabase's exposed schemas.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
revoke create on schema public from public, anon, authenticated;

create type public.app_role as enum ('manager', 'executor');
create type public.task_status as enum ('new', 'in_progress', 'in_review', 'accepted', 'rework');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null check (
    char_length(display_name) between 1 and 100 and display_name ~ '[^[:space:]]'
  ),
  role public.app_role not null,
  created_at timestamptz not null default now()
);

create table public.objects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200 and name ~ '[^[:space:]]'),
  address text not null check (char_length(address) between 1 and 500 and address ~ '[^[:space:]]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200 and title ~ '[^[:space:]]'),
  description text not null default '' check (char_length(description) <= 10000),
  object_id uuid not null references public.objects(id) on delete restrict,
  assignee_id uuid not null references public.profiles(id) on delete restrict,
  assignee_name text not null,
  status public.task_status not null default 'new',
  created_by uuid not null references public.profiles(id) on delete restrict,
  author_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.task_status_history (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.tasks(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  actor_name text not null,
  changed_at timestamptz not null default now(),
  from_status public.task_status,
  to_status public.task_status not null,
  comment text check (comment is null or (char_length(comment) <= 2000 and comment ~ '[^[:space:]]')),
  constraint history_valid_edge check (
    (from_status is null and to_status = 'new') or
    (from_status is not null and (
      (from_status = 'new' and to_status = 'in_progress') or
      (from_status = 'in_progress' and to_status = 'in_review') or
      (from_status = 'in_review' and to_status in ('accepted', 'rework')) or
      (from_status = 'rework' and to_status = 'in_progress')
    ))
  ),
  constraint history_rework_comment check (to_status <> 'rework' or comment is not null)
);

create index tasks_assignee_active_idx on public.tasks(assignee_id, object_id) where deleted_at is null;
create index tasks_object_active_idx on public.tasks(object_id) where deleted_at is null;
create index history_task_time_idx on public.task_status_history(task_id, changed_at, id);

alter table public.profiles enable row level security;
alter table public.objects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_status_history enable row level security;

-- The role lives in an administrator-controlled table, never user_metadata.
-- SECURITY DEFINER avoids recursive RLS when a profile policy checks the role.
create function private.request_role()
returns public.app_role language sql stable security definer set search_path = ''
as $$ select p.role from public.profiles p where p.id = (select auth.uid()) $$;

create policy profiles_read on public.profiles for select to authenticated
using (id = (select auth.uid()) or (select private.request_role()) = 'manager');

-- Managers may read archived records for audit. The ordinary UI filters deleted_at.
create policy tasks_read on public.tasks for select to authenticated
using (
  (select private.request_role()) = 'manager' or
  ((select private.request_role()) = 'executor' and
   assignee_id = (select auth.uid()) and deleted_at is null)
);

-- tasks_read does not reference objects: there is no cyclic RLS dependency.
create policy objects_read on public.objects for select to authenticated
using (
  (select private.request_role()) = 'manager' or
  (deleted_at is null and (select private.request_role()) = 'executor' and exists (
    select 1 from public.tasks t
    where t.object_id = objects.id and t.assignee_id = (select auth.uid()) and t.deleted_at is null
  ))
);

create policy history_read on public.task_status_history for select to authenticated
using (
  (select private.request_role()) = 'manager' or exists (
    select 1 from public.tasks t
    where t.id = task_status_history.task_id and t.assignee_id = (select auth.uid()) and t.deleted_at is null
  )
);

revoke all on public.profiles, public.objects, public.tasks, public.task_status_history
  from public, anon, authenticated;
grant select on public.profiles, public.objects, public.tasks, public.task_status_history to authenticated;
revoke all on sequence public.task_status_history_id_seq from public, anon, authenticated;

create function private.reject_history_mutation()
returns trigger language plpgsql security invoker set search_path = ''
as $$ begin
  raise exception using errcode = '42501', message = 'history_is_immutable';
end $$;

create trigger history_no_update_delete
before update or delete on public.task_status_history
for each row execute function private.reject_history_mutation();
create trigger history_no_truncate
before truncate on public.task_status_history
for each statement execute function private.reject_history_mutation();

create function private.require_manager()
returns uuid language plpgsql security invoker set search_path = ''
as $$ begin
  if auth.uid() is null or private.request_role() is distinct from 'manager'::public.app_role then
    raise exception using errcode = '42501', message = 'manager_required';
  end if;
  return auth.uid();
end $$;

create function private.executor_name(p_assignee_id uuid)
returns text language plpgsql security invoker set search_path = ''
as $$ declare v_name text; begin
  select p.display_name into v_name from public.profiles p
    where p.id = p_assignee_id and p.role = 'executor' for share;
  if not found then
    raise exception using errcode = '22023', message = 'executor_required';
  end if;
  return v_name;
end $$;

create function private.create_object(p_name text, p_address text)
returns uuid language plpgsql security definer set search_path = ''
as $$ declare v_id uuid; begin
  perform private.require_manager();
  insert into public.objects(name, address) values (btrim(p_name), btrim(p_address)) returning id into v_id;
  return v_id;
end $$;

create function private.update_object(p_object_id uuid, p_name text, p_address text)
returns uuid language plpgsql security definer set search_path = ''
as $$ begin
  perform private.require_manager();
  perform 1 from public.objects o where o.id = p_object_id and o.deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'object_not_found'; end if;
  update public.objects set name = btrim(p_name), address = btrim(p_address), updated_at = clock_timestamp()
    where id = p_object_id;
  return p_object_id;
end $$;

create function private.archive_object(p_object_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$ declare v_now timestamptz; begin
  perform private.require_manager();
  -- The same lock is taken by create_task/update_task before attaching a task.
  perform 1 from public.objects o where o.id = p_object_id and o.deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'object_not_found'; end if;
  if exists (select 1 from public.tasks t where t.object_id = p_object_id and t.deleted_at is null) then
    raise exception using errcode = '22023', message = 'object_has_active_tasks';
  end if;
  v_now := clock_timestamp();
  update public.objects set deleted_at = v_now, updated_at = v_now where id = p_object_id;
end $$;

create function private.create_task(p_title text, p_description text, p_object_id uuid, p_assignee_id uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$ declare
  v_id uuid; v_actor uuid; v_actor_name text; v_assignee_name text; v_now timestamptz;
begin
  v_actor := private.require_manager();
  select p.display_name into v_actor_name from public.profiles p where p.id = v_actor;
  v_assignee_name := private.executor_name(p_assignee_id);
  perform 1 from public.objects o where o.id = p_object_id and o.deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'object_not_found'; end if;
  v_now := clock_timestamp();
  insert into public.tasks(title, description, object_id, assignee_id, assignee_name,
    status, created_by, author_name, created_at, updated_at)
  values (btrim(p_title), coalesce(p_description, ''), p_object_id, p_assignee_id, v_assignee_name,
    'new', v_actor, v_actor_name, v_now, v_now) returning id into v_id;
  insert into public.task_status_history(task_id, actor_id, actor_name, changed_at, from_status, to_status)
    values (v_id, v_actor, v_actor_name, v_now, null, 'new');
  return v_id;
end $$;

create function private.update_task(p_task_id uuid, p_title text, p_description text, p_object_id uuid, p_assignee_id uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$ declare v_assignee_name text; begin
  perform private.require_manager();
  perform 1 from public.tasks t where t.id = p_task_id and t.deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'task_not_found'; end if;
  v_assignee_name := private.executor_name(p_assignee_id);
  perform 1 from public.objects o where o.id = p_object_id and o.deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'object_not_found'; end if;
  -- Content/assignee edits never change status, author, creation time or history.
  update public.tasks set title = btrim(p_title), description = coalesce(p_description, ''),
    object_id = p_object_id, assignee_id = p_assignee_id, assignee_name = v_assignee_name,
    updated_at = clock_timestamp() where id = p_task_id;
  return p_task_id;
end $$;

create function private.archive_task(p_task_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$ declare v_now timestamptz; begin
  perform private.require_manager();
  perform 1 from public.tasks t where t.id = p_task_id and t.deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'task_not_found'; end if;
  v_now := clock_timestamp();
  update public.tasks set deleted_at = v_now, updated_at = v_now where id = p_task_id;
  -- No hard delete and no cascading delete of the audit trail.
end $$;

create function private.transition_task(
  p_task_id uuid, p_expected_status public.task_status, p_to_status public.task_status, p_comment text default null
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
  if p_expected_status is null or v_task.status is distinct from p_expected_status then
    raise exception using errcode = '40001', message = 'stale_status_refresh_required';
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
  update public.tasks set status = p_to_status, updated_at = v_now where id = p_task_id;
  insert into public.task_status_history(task_id, actor_id, actor_name, changed_at, from_status, to_status, comment)
    values (p_task_id, v_actor, v_actor_name, v_now, v_task.status, p_to_status, v_comment);
  -- Both statements commit together. A failed insert rolls back the status update.
  return p_task_id;
end $$;

-- Small exposed INVOKER wrappers. The DEFINER implementations are not in the API schema.
-- Their own checks are mandatory: a schema boundary is not an authorization check.
create function public.create_object(p_name text, p_address text)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_object(p_name, p_address) $$;

create function public.update_object(p_object_id uuid, p_name text, p_address text)
returns uuid language sql security invoker set search_path = ''
as $$ select private.update_object(p_object_id, p_name, p_address) $$;

create function public.archive_object(p_object_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.archive_object(p_object_id) $$;

create function public.create_task(p_title text, p_description text, p_object_id uuid, p_assignee_id uuid)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_task(p_title, p_description, p_object_id, p_assignee_id) $$;

create function public.update_task(p_task_id uuid, p_title text, p_description text, p_object_id uuid, p_assignee_id uuid)
returns uuid language sql security invoker set search_path = ''
as $$ select private.update_task(p_task_id, p_title, p_description, p_object_id, p_assignee_id) $$;

create function public.archive_task(p_task_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.archive_task(p_task_id) $$;

create function public.transition_task(
  p_task_id uuid, p_expected_status public.task_status, p_to_status public.task_status, p_comment text default null
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.transition_task(p_task_id, p_expected_status, p_to_status, p_comment) $$;

-- PostgreSQL grants EXECUTE to PUBLIC by default; revoke it explicitly, as well as
-- any direct anon/authenticated grants added by Supabase's default privileges.
revoke all on function
  private.request_role(), private.reject_history_mutation(), private.require_manager(), private.executor_name(uuid),
  private.create_object(text,text), private.update_object(uuid,text,text), private.archive_object(uuid),
  private.create_task(text,text,uuid,uuid), private.update_task(uuid,text,text,uuid,uuid), private.archive_task(uuid),
  private.transition_task(uuid,public.task_status,public.task_status,text),
  public.create_object(text,text), public.update_object(uuid,text,text), public.archive_object(uuid),
  public.create_task(text,text,uuid,uuid), public.update_task(uuid,text,text,uuid,uuid), public.archive_task(uuid),
  public.transition_task(uuid,public.task_status,public.task_status,text)
from public, anon, authenticated;

-- Private helpers used only by the owner remain uncallable by authenticated users.
grant execute on function
  private.request_role(),
  private.create_object(text,text), private.update_object(uuid,text,text), private.archive_object(uuid),
  private.create_task(text,text,uuid,uuid), private.update_task(uuid,text,text,uuid,uuid), private.archive_task(uuid),
  private.transition_task(uuid,public.task_status,public.task_status,text),
  public.create_object(text,text), public.update_object(uuid,text,text), public.archive_object(uuid),
  public.create_task(text,text,uuid,uuid), public.update_task(uuid,text,text,uuid,uuid), public.archive_task(uuid),
  public.transition_task(uuid,public.task_status,public.task_status,text)
to authenticated;

comment on table public.profiles is 'Provision by trusted SQL/admin only. Client cannot create or change roles.';
comment on table public.task_status_history is 'Append-only through API. Status RPC writes history in the same transaction.';
comment on schema private is 'Implementation only: never expose this schema in the Supabase Data API.';

commit;
