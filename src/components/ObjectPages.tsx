import { useState } from 'react';
import type { ConstructionObject } from '../domain/types';
import type { TaskRow } from '../lib/crm';
import { EditorToggle, ObjectEditor, TaskEditor } from './Editors';
import type { Save } from './Editors';
import { TaskList } from './TaskList';

interface ObjectListProps {
  sites: ConstructionObject[];
  manager: boolean;
  save: Save;
}

export function ObjectList({ sites, manager, save }: ObjectListProps) {
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="heading">
        <h1>Объекты</h1>
        {manager && (
          <EditorToggle
            open={creating}
            label="Создать объект"
            onClick={() => setCreating(!creating)}
          />
        )}
      </div>
      {creating && <ObjectEditor save={save} />}
      {sites.length === 0 && <p className="empty">Пока нет доступных объектов.</p>}
      {sites.length > 0 && (
        <ul className="records">
          {sites.map((site) => (
            <li key={site.id}>
              <a href={'/objects/' + site.id}>
                <span>
                  <strong>{site.name}</strong>
                  <small>{site.address}</small>
                </span>
                <span aria-hidden="true">→</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface ObjectPageProps {
  site: ConstructionObject;
  tasks: TaskRow[];
  manager: boolean;
  save: Save;
}

export function ObjectPage({ site, tasks, manager, save }: ObjectPageProps) {
  const [editor, setEditor] = useState<'object' | 'task' | null>(null);
  const hasTasks = tasks.length > 0;

  function toggleEditor(kind: 'object' | 'task') {
    setEditor((current) => (current === kind ? null : kind));
  }

  function archiveObject() {
    if (!window.confirm('Удалить этот объект из рабочего списка?')) return;
    save('archive_object', { p_object_id: site.id }, () => '/objects');
  }

  return (
    <>
      <p className="eyebrow">КАРТОЧКА ОБЪЕКТА</p>
      <h1>{site.name}</h1>
      <p>{site.address}</p>
      {manager && (
        <div className="controls">
          <EditorToggle
            open={editor === 'object'}
            label="Редактировать объект"
            onClick={() => toggleEditor('object')}
          />
          <button className="danger" disabled={hasTasks} onClick={archiveObject}>
            Удалить объект
          </button>
          {hasTasks && <small>Для удаления перенесите или удалите все задачи.</small>}
        </div>
      )}
      {editor === 'object' && <ObjectEditor object={site} save={save} />}
      <div className="heading">
        <h2>Задачи объекта</h2>
        {manager && (
          <EditorToggle
            open={editor === 'task'}
            label="Создать задачу"
            onClick={() => toggleEditor('task')}
          />
        )}
      </div>
      {editor === 'task' && <TaskEditor objectId={site.id} save={save} />}
      <TaskList rows={tasks} />
    </>
  );
}
