import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ConstructionObject, Profile, Task } from '../domain/types';
import { executors, objects } from '../lib/crm';
import type { Command } from '../lib/crm';

export type Save = (
  command: Command,
  args: Record<string, string | number | null>,
  destination?: (id: string) => string
) => void;

function textField(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}

export function ObjectEditor({ object, save }: { object?: ConstructionObject; save: Save }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields = { p_name: textField(form, 'name'), p_address: textField(form, 'address') };
    if (object) {
      save('update_object', { ...fields, p_object_id: object.id });
    } else {
      save('create_object', fields, (id) => '/objects/' + id);
    }
  }
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Название
        <input
          autoFocus
          required
          pattern=".*\S.*"
          maxLength={200}
          name="name"
          defaultValue={object?.name}
        />
      </label>
      <label>
        Адрес
        <input
          required
          pattern=".*\S.*"
          maxLength={500}
          name="address"
          defaultValue={object?.address}
        />
      </label>
      <button>Сохранить объект</button>
    </form>
  );
}

export function TaskEditor({
  objectId,
  task,
  save,
}: {
  objectId: string;
  task?: Task;
  save: Save;
}) {
  const [choices, setChoices] = useState<{ sites: ConstructionObject[]; people: Profile[] }>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    async function loadChoices() {
      try {
        const [sites, people] = await Promise.all([objects(), executors()]);
        if (active) setChoices({ sites, people });
      } catch {
        if (active) setFailed(true);
      }
    }
    void loadChoices();
    return () => {
      active = false;
    };
  }, [attempt]);
  function retry() {
    setFailed(false);
    setAttempt((previous) => previous + 1);
  }

  if (failed) {
    return (
      <p role="alert">
        Не удалось загрузить справочники. <button onClick={retry}>Повторить</button>
      </p>
    );
  }
  if (!choices) return <p role="status">Загружаем объекты и исполнителей…</p>;
  if (!choices.people.length || !choices.sites.length)
    return <p>Для назначения нужны действующий объект и профиль исполнителя.</p>;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields = {
      p_title: textField(form, 'title'),
      p_description: textField(form, 'description'),
      p_object_id: textField(form, 'object'),
      p_assignee_id: textField(form, 'assignee'),
    };
    if (task) {
      save('update_task', { ...fields, p_task_id: task.id });
    } else {
      save('create_task', fields, (id) => '/tasks/' + id);
    }
  }
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Название задачи
        <input
          autoFocus
          name="title"
          required
          pattern=".*\S.*"
          maxLength={200}
          defaultValue={task?.title}
        />
      </label>
      <label>
        Описание
        <textarea name="description" rows={3} maxLength={10000} defaultValue={task?.description} />
      </label>
      <div>
        <label htmlFor="task-object">Объект</label>
        <select id="task-object" name="object" required defaultValue={objectId}>
          {choices.sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="task-assignee">Исполнитель</label>
        <select id="task-assignee" name="assignee" required defaultValue={task?.assignee_id ?? ''}>
          <option value="" disabled>
            Выберите исполнителя
          </option>
          {choices.people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.display_name}
            </option>
          ))}
        </select>
      </div>
      <button>Сохранить задачу</button>
    </form>
  );
}

interface EditorToggleProps {
  open: boolean;
  label: string;
  onClick: () => void;
}

export function EditorToggle({ open, label, onClick }: EditorToggleProps) {
  return (
    <button type="button" className="secondary" aria-expanded={open} onClick={onClick}>
      {open ? 'Отменить' : label}
    </button>
  );
}
