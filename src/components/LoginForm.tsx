import { useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../lib/supabase';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) {
        setError(
          'Не удалось войти. Проверьте email и пароль, а также доступность проекта Supabase.'
        );
      } else {
        setPassword('');
      }
    } catch {
      setError('Нет связи с сервером. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <label htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        disabled={busy}
      />
      <label htmlFor="password">Пароль</label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        disabled={busy}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {busy ? 'Входим…' : 'Войти'}
      </button>
      <p className="muted small">
        Для входа используйте учётную запись, которую создал администратор.
      </p>
    </form>
  );
}
