import { useEffect, useRef, useState } from 'react';
import type { Profile } from '../domain/types';
import { write, writeError } from '../lib/crm';
import { readScreen } from '../lib/readScreen';
import type { Screen } from '../lib/readScreen';
import type { Save } from './Editors';
import { ObjectList, ObjectPage } from './ObjectPages';
import { TaskList } from './TaskList';
import { TaskPage } from './TaskPage';

type View = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; screen: Screen };

function renderPage(screen: Screen, profile: Profile, save: Save) {
  const manager = profile.role === 'manager';
  switch (screen.kind) {
    case 'objects':
      return <ObjectList sites={screen.sites} manager={manager} save={save} />;
    case 'object':
      return <ObjectPage site={screen.site} tasks={screen.tasks} manager={manager} save={save} />;
    case 'task':
      return <TaskPage task={screen.task} events={screen.events} profile={profile} save={save} />;
    case 'mine':
      return (
        <>
          <h1>Мои задачи</h1>
          <TaskList rows={screen.tasks} mine />
        </>
      );
    case 'missing':
      return (
        <>
          <h1>Страница недоступна</h1>
          <p>Запись удалена, недоступна вашему аккаунту или ссылка неверна.</p>
        </>
      );
  }
}

interface WorkspaceContentProps {
  view: View;
  profile: Profile;
  save: Save;
  busy: boolean;
}

function WorkspaceContent({ view, profile, save, busy }: WorkspaceContentProps) {
  if (view.status === 'loading') return <p role="status">Загружаем данные…</p>;
  if (view.status === 'failed') {
    return (
      <p className="error" role="alert">
        Не удалось прочитать данные. Проверьте соединение и нажмите «Обновить».
      </p>
    );
  }

  return (
    <fieldset className="workspace" disabled={busy} aria-busy={busy}>
      {renderPage(view.screen, profile, save)}
    </fieldset>
  );
}

export function Workspace({ profile }: { profile: Profile }) {
  const [view, setView] = useState<View>({ status: 'loading' });
  const [mustRefresh, setMustRefresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const writePending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const screen = await readScreen(profile, window.location.pathname);
        if (current) setView({ status: 'ready', screen });
      } catch {
        if (current) setView({ status: 'failed' });
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, [profile]);

  // Keep the current form mounted during a reread so a failed write preserves the draft.
  async function reread() {
    try {
      const screen = await readScreen(profile, window.location.pathname);
      if (mounted.current) {
        setView({ status: 'ready', screen });
        setMustRefresh(false);
      }
    } catch {
      if (mounted.current) setMustRefresh(true);
    }
  }

  async function refreshManually() {
    setBusy(true);
    await reread();
    if (mounted.current) setBusy(false);
  }

  const save: Save = async (command, args, destination) => {
    if (writePending.current || mustRefresh) return;
    writePending.current = true;
    setBusy(true);
    setNotice('');
    try {
      const id = await write(command, args);
      if (!mounted.current) return;
      if (destination) {
        window.location.assign(destination(id ?? ''));
        return;
      }
      setNotice('Изменения сохранены.');
      // End a successfully submitted edit before showing the updated records.
      setView({ status: 'loading' });
    } catch (error) {
      if (!mounted.current) return;
      setNotice(writeError(error));
    }
    // A lost response can follow a successful write. Reread before allowing another action.
    await reread();
    if (!mounted.current) return;
    writePending.current = false;
    setBusy(false);
  };

  return (
    <>
      <nav aria-label="Разделы">
        <a href="/objects">Объекты</a>
        {profile.role === 'executor' && <a href="/my-tasks">Мои задачи</a>}
        <button
          className="link"
          disabled={busy || (view.status === 'loading' && !mustRefresh)}
          onClick={refreshManually}
        >
          Обновить
        </button>
      </nav>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {mustRefresh && (
        <p className="error" role="alert">
          Не удалось обновить данные. Перед следующим сохранением нажмите «Обновить».
        </p>
      )}
      <WorkspaceContent view={view} profile={profile} save={save} busy={busy || mustRefresh} />
    </>
  );
}
