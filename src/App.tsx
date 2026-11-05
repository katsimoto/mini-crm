import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { AccountSummary } from './components/AccountSummary';
import { LoginForm } from './components/LoginForm';
import { supabase, supabaseConfig } from './lib/supabase';

function SessionContent() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(supabase !== null);

  useEffect(() => {
    if (!supabase) return;
    // INITIAL_SESSION restores an existing login. Keep this callback synchronous:
    // fetch the profile in a separate effect after the session has changed.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoadingSession(false);
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []);

  if (supabaseConfig.status !== 'ready') {
    return (
      <section className="panel">
        <h1>Подключение к CRM</h1>
        <p>{supabaseConfig.message}</p>
        <p>После настройки перезапустите приложение. Инструкция находится в README.md.</p>
      </section>
    );
  }

  if (loadingSession) return <p role="status">Проверяем сессию…</p>;

  if (session) {
    const { id, email } = session.user;
    return <AccountSummary key={id} userId={id} email={email} />;
  }

  return (
    <section className="panel login">
      <p className="eyebrow">РАБОЧИЙ КАБИНЕТ</p>
      <h1>Вход в систему</h1>
      <LoginForm />
    </section>
  );
}

export function App() {
  return (
    <div className="shell">
      <header>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            О
          </span>
          Объекты и задачи
        </div>
        <span className="muted small">Мини-CRM</span>
      </header>
      <main>
        <SessionContent />
      </main>
    </div>
  );
}
