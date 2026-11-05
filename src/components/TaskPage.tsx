import { useState } from 'react';
import { availableTransitions } from '../domain/actions';
import { STATUS_LABELS } from '../domain/types';
import type { Profile, Task, TaskStatus, TaskStatusHistory } from '../domain/types';
import { EditorToggle, TaskEditor } from './Editors';
import type { Save } from './Editors';
import { StatusBadge } from './TaskList';

const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });

function LocalTime({ iso }: { iso: string }) {
  return <time dateTime={iso}>{dateFormat.format(new Date(iso))}</time>;
}

function StatusHistory({ events }: { events: TaskStatusHistory[] }) {
  if (!events.length) return <p>Событий пока нет.</p>;

  return (
    <ol className="history">
      {events.map((event) => {
        const previous = event.from_status ? STATUS_LABELS[event.from_status] : 'Создание';
        return (
          <li key={event.id}>
            <strong>
              {previous} → {STATUS_LABELS[event.to_status]}
            </strong>
            <small>
              {event.actor_name} · <LocalTime iso={event.changed_at} />
            </small>
            {event.comment && <p className="prose">{event.comment}</p>}
          </li>
        );
      })}
    </ol>
  );
}

interface StatusActionsProps {
  task: Task;
  profile: Profile;
  save: Save;
}

function StatusActions({ task, profile, save }: StatusActionsProps) {
  const [comment, setComment] = useState('');
  const actions = availableTransitions(profile, task);
  if (!actions.length) return null;

  const trimmedComment = comment.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '');
  function changeStatus(to: TaskStatus) {
    save('transition_task', {
      p_task_id: task.id,
      p_expected_status: task.status,
      p_to_status: to,
      p_comment: trimmedComment || null,
    });
  }

  return (
    <section className="actions">
      <h2>Смена статуса</h2>
      <label>
        Комментарий{profile.role === 'manager' && ' (обязателен для доработки)'}
        <textarea
          maxLength={2000}
          rows={2}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>
      <div className="controls">
        {actions.map((action) => (
          <button
            key={action.toStatus}
            disabled={action.requiresComment && !trimmedComment}
            onClick={() => changeStatus(action.toStatus)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}

interface TaskPageProps {
  task: Task & { objects: { name: string } };
  events: TaskStatusHistory[];
  profile: Profile;
  save: Save;
}

export function TaskPage({ task, events, profile, save }: TaskPageProps) {
  const [editing, setEditing] = useState(false);
  const objectPath = '/objects/' + task.object_id;

  function archiveTask() {
    if (!window.confirm('Удалить задачу из рабочего списка? История сохранится.')) return;
    save('archive_task', { p_task_id: task.id }, () => objectPath);
  }

  return (
    <>
      <p>
        <a href={objectPath}>← {task.objects.name}</a>
      </p>
      <div className="heading">
        <h1>{task.title}</h1>
        <StatusBadge value={task.status} />
      </div>
      <p className="prose">{task.description || 'Описание не добавлено.'}</p>
      <dl>
        <div>
          <dt>Исполнитель</dt>
          <dd>{task.assignee_name}</dd>
        </div>
        <div>
          <dt>Постановщик</dt>
          <dd>{task.author_name}</dd>
        </div>
        <div>
          <dt>Создана</dt>
          <dd>
            <LocalTime iso={task.created_at} />
          </dd>
        </div>
      </dl>
      {profile.role === 'manager' && (
        <div className="controls">
          <EditorToggle
            open={editing}
            label="Редактировать задачу"
            onClick={() => setEditing(!editing)}
          />
          <button className="danger" onClick={archiveTask}>
            Удалить задачу
          </button>
        </div>
      )}
      {editing && <TaskEditor objectId={task.object_id} task={task} save={save} />}
      <StatusActions task={task} profile={profile} save={save} />
      <h2>История статусов</h2>
      <StatusHistory events={events} />
    </>
  );
}
