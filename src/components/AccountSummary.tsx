import { useEffect, useState } from 'react';
import { ROLE_LABELS } from '../domain/types';
import type { Profile } from '../domain/types';
import { supabase } from '../lib/supabase';
import { Workspace } from './Workspace';

function isProfile(value: unknown): value is Profile {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    'display_name' in value &&
    typeof value.display_name === 'string' &&
    'role' in value &&
    (value.role === 'manager' || value.role === 'executor')
  );
}

export function AccountSummary({ userId, email }: { userId: string; email: string | undefined }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    const client = supabase;
    async function loadProfile() {
      try {
        const { data, error: queryError } = await client
          .from('profiles')
          .select('id,display_name,role')
          .eq('id', userId)
          .maybeSingle();
        if (cancelled) return;
        if (queryError || !isProfile(data)) {
          setError(
            'Профиль с ролью не найден или недоступен. Проверьте миграцию и назначение роли администратором.'
          );
        } else {
          setProfile(data);
        }
      } catch {
        if (!cancelled) setError('Не удалось загрузить профиль. Проверьте подключение.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadProfile();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function signOut() {
    if (!supabase || signingOut) return;
    setSigningOut(true);
    try {
      const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
      if (signOutError) setError('Не удалось выйти. Попробуйте ещё раз.');
    } catch {
      setError('Не удалось выйти. Проверьте подключение.');
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <>
      <div className="account">
        <div>
          {loading && <span role="status">Загружаем профиль…</span>}
          {profile && (
            <>
              <strong>{profile.display_name}</strong>{' '}
              <span className="role">{ROLE_LABELS[profile.role]}</span>
            </>
          )}
          <small>{email}</small>
        </div>
        <button className="secondary" onClick={() => void signOut()} disabled={signingOut}>
          {signingOut ? 'Выходим…' : 'Выйти'}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}{' '}
          <button className="link" onClick={() => location.reload()}>
            Обновить
          </button>
        </p>
      )}
      {profile && <Workspace profile={profile} />}
    </>
  );
}
