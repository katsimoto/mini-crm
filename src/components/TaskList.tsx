import { STATUS_LABELS } from '../domain/types';
import type { TaskStatus } from '../domain/types';
import type { TaskRow } from '../lib/crm';

export function StatusBadge({ value }: { value: TaskStatus }) {
  return <span className={'badge ' + value}>{STATUS_LABELS[value]}</span>;
}

export function TaskList({ rows, mine = false }: { rows: TaskRow[]; mine?: boolean }) {
  if (!rows.length)
    return (
      <p className="empty">
        {mine ? 'У вас пока нет назначенных задач.' : 'На объекте пока нет доступных вам задач.'}
      </p>
    );
  return (
    <ul className="records">
      {rows.map((row) => (
        <li key={row.id}>
          <a href={'/tasks/' + row.id}>
            <span>
              <strong>{row.title}</strong>
              <small>{mine ? row.objects.name : row.assignee_name}</small>
            </span>
            <StatusBadge value={row.status} />
          </a>
        </li>
      ))}
    </ul>
  );
}
