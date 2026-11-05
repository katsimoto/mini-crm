import { describe, expect, it } from 'vitest';
import { availableTransitions } from './actions';
import { TASK_STATUSES } from './types';

const executor = { id: 'executor-a', role: 'executor' } as const;
const manager = { id: 'manager', role: 'manager' } as const;
const baseTask = { assignee_id: 'executor-a', deleted_at: null };

describe('available actions at the permission boundaries', () => {
  it('never offers actions on someone else’s task to an executor', () => {
    for (const status of TASK_STATUSES) {
      expect(availableTransitions(executor, { ...baseTask, assignee_id: 'executor-b', status })).toEqual([]);
    }
  });

  it('offers both review decisions to any manager, with a required rework comment', () => {
    expect(availableTransitions(manager, { ...baseTask, status: 'in_review' })).toEqual([
      { toStatus: 'accepted', label: 'Принять', requiresComment: false },
      { toStatus: 'rework', label: 'Вернуть на доработку', requiresComment: true },
    ]);
  });

  it('does not let a manager act as the assigned executor', () => {
    for (const status of ['new', 'in_progress', 'rework', 'accepted'] as const) {
      expect(availableTransitions(manager, { ...baseTask, assignee_id: manager.id, status })).toEqual([]);
    }
  });

  it('takes rework through in_progress rather than directly back to review', () => {
    expect(availableTransitions(executor, { ...baseTask, status: 'rework' }).map((a) => a.toStatus))
      .toEqual(['in_progress']);
  });

  it('offers no transition after acceptance or deletion, or without a session', () => {
    expect(availableTransitions(executor, { ...baseTask, status: 'accepted' })).toEqual([]);
    expect(availableTransitions(manager, {
      ...baseTask, status: 'in_review', deleted_at: '2026-01-01T00:00:00Z',
    })).toEqual([]);
    expect(availableTransitions(null, { ...baseTask, status: 'new' })).toEqual([]);
  });
});
