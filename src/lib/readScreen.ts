import type { Profile } from '../domain/types';
import * as api from './crm';

export async function readScreen(profile: Profile, pathname: string) {
  const path = pathname.replace(/\/$/, '');
  if (path === '' || path === '/objects')
    return { kind: 'objects', sites: await api.objects() } as const;
  if (path === '/my-tasks' && profile.role === 'executor') {
    return { kind: 'mine', tasks: await api.tasks('assignee_id', profile.id) } as const;
  }
  const match =
    /^\/(objects|tasks)\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i.exec(path);
  const id = match?.[2];
  if (id && match?.[1] === 'objects') {
    const [site, tasks] = await Promise.all([api.objectCard(id), api.tasks('object_id', id)]);
    if (site) return { kind: 'object', site, tasks } as const;
  } else if (id) {
    const [task, events] = await Promise.all([api.taskCard(id), api.history(id)]);
    if (task) return { kind: 'task', task, events } as const;
  }
  return { kind: 'missing' } as const;
}

export type Screen = Awaited<ReturnType<typeof readScreen>>;
