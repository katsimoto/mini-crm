import type { ConstructionObject, Profile, Task, TaskStatusHistory } from '../domain/types';
import { supabase } from './supabase';

// Called only inside the configured, authenticated workspace.
function client() {
  if (!supabase) throw new Error('configuration_missing');
  return supabase;
}

type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

// Page below the default PostgREST row limit; keep a stable sort across pages.
async function rows<T>(page: (from: number, to: number) => Page<T>): Promise<T[]> {
  const all: T[] = [];
  for (;;) {
    const { data, error } = await page(all.length, all.length + 199);
    if (error) throw error;
    if (!data?.length) return all;
    all.push(...data);
    // PostgREST may cap a response below 200 rows; only an empty page marks the end.
  }
}

export function objects() {
  return rows<ConstructionObject>((from, to) =>
    client()
      .from('objects')
      .select('id,name,address,deleted_at')
      .is('deleted_at', null)
      .order('name')
      .order('id')
      .range(from, to)
  );
}

export function executors() {
  return rows<Profile>((from, to) =>
    client()
      .from('profiles')
      .select('id,display_name,role')
      .eq('role', 'executor')
      .order('display_name')
      .order('id')
      .range(from, to)
  );
}

export type TaskRow = Pick<Task, 'id' | 'title' | 'assignee_name' | 'status'> & {
  objects: { name: string };
};

export function tasks(field: 'object_id' | 'assignee_id', id: string) {
  return rows<TaskRow>((from, to) =>
    client()
      .from('tasks')
      .select('id,title,assignee_name,status,objects(name)')
      .is('deleted_at', null)
      .eq(field, id)
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, to)
      .overrideTypes<TaskRow[], { merge: false }>()
  );
}

export async function objectCard(id: string) {
  const { data, error } = await client()
    .from('objects')
    .select('id,name,address,deleted_at')
    .is('deleted_at', null)
    .eq('id', id)
    .maybeSingle<ConstructionObject>();
  if (error) throw error;
  return data;
}

export async function taskCard(id: string) {
  const { data, error } = await client()
    .from('tasks')
    .select('*,objects(name)')
    .is('deleted_at', null)
    .eq('id', id)
    .maybeSingle<Task & { objects: { name: string } }>();
  if (error) throw error;
  return data;
}

export function history(id: string) {
  return rows<TaskStatusHistory>((from, to) =>
    client().from('task_status_history').select('*').eq('task_id', id).order('id').range(from, to)
  );
}

export type Command =
  | 'create_object'
  | 'update_object'
  | 'archive_object'
  | 'create_task'
  | 'update_task'
  | 'archive_task'
  | 'transition_task';

export async function write(
  command: Command,
  args: Record<string, string | number | null>
): Promise<string | null> {
  const { data, error } = await client().rpc(command, args).retry(false);
  if (error) throw error;
  return data;
}

const messages: Record<string, string> = {
  manager_required: 'Действие доступно только постановщику.',
  authentication_required: 'Для этого действия войдите в систему.',
  task_unavailable: 'Задача удалена или больше вам недоступна.',
  object_not_found: 'Объект удалён или недоступен.',
  task_not_found: 'Задача удалена или недоступна.',
  executor_required: 'Выберите пользователя с ролью исполнителя.',
  stale_status_refresh_required:
    'Статус уже изменился. Сверьтесь с историей перед следующим действием.',
  invalid_status_transition: 'Этот переход недоступен для вашей роли и текущего статуса.',
  rework_comment_required: 'Введите причину возврата на доработку.',
  comment_too_long: 'Сократите комментарий до 2 000 символов.',
  object_has_active_tasks: 'Сначала перенесите или удалите все задачи этого объекта.',
};

export function writeError(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return (
    messages[message] ??
    'Не удалось подтвердить результат. Проверьте обновлённые данные перед повтором.'
  );
}
