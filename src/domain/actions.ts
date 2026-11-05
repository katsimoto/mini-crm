import type { Profile, Task, TaskStatus } from './types';

export interface TransitionAction {
  toStatus: TaskStatus;
  label: string;
  requiresComment: boolean;
}

type Viewer = Pick<Profile, 'id' | 'role'>;
type TaskAccess = Pick<Task, 'status' | 'assignee_id' | 'deleted_at'>;

/** UI convenience only. The database independently enforces all permissions. */
export function availableTransitions(user: Viewer | null, task: TaskAccess): TransitionAction[] {
  if (!user || task.deleted_at) return [];

  if (user.role === 'manager') {
    if (task.status !== 'in_review') return [];
    return [
      { toStatus: 'accepted', label: 'Принять', requiresComment: false },
      { toStatus: 'rework', label: 'Вернуть на доработку', requiresComment: true },
    ];
  }

  if (user.id !== task.assignee_id) return [];
  if (task.status === 'new' || task.status === 'rework') {
    return [{ toStatus: 'in_progress', label: 'Взять в работу', requiresComment: false }];
  }
  if (task.status === 'in_progress') {
    return [{ toStatus: 'in_review', label: 'Отправить на проверку', requiresComment: false }];
  }
  return [];
}
