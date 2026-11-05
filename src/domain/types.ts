export const TASK_STATUSES = ['new', 'in_progress', 'in_review', 'accepted', 'rework'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export type UserRole = 'manager' | 'executor';

export interface Profile {
  id: string;
  display_name: string;
  role: UserRole;
}

export interface ConstructionObject {
  id: string;
  name: string;
  address: string;
  deleted_at: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  object_id: string;
  assignee_id: string;
  assignee_name: string;
  status: TaskStatus;
  created_by: string;
  author_name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TaskStatusHistory {
  id: number;
  task_id: string;
  actor_id: string;
  actor_name: string;
  changed_at: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus;
  comment: string | null;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  manager: 'Постановщик',
  executor: 'Исполнитель',
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  new: 'Новая',
  in_progress: 'В работе',
  in_review: 'На проверке',
  accepted: 'Принята',
  rework: 'На доработке',
};
