type PublicEnvironment = Record<string, string | undefined>;

export type PublicSupabaseConfig =
  | { status: 'ready'; url: string; publishableKey: string }
  | { status: 'missing' | 'invalid'; message: string };

function isPublicKey(key: string): boolean {
  if (key.startsWith('sb_publishable_')) return true;
  if (key.startsWith('sb_secret_')) return false;

  // Legacy anon keys are JWTs. This only prevents accidental secret exposure;
  // JWT authenticity and access permissions are checked by Supabase, not here.
  try {
    const parts = key.split('.');
    if (parts.length !== 3 || !parts[1]) return false;
    const payload: unknown = JSON.parse(
      atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')),
    );
    return typeof payload === 'object' && payload !== null &&
      'role' in payload && payload.role === 'anon';
  } catch {
    return false;
  }
}

export function readPublicSupabaseConfig(env: PublicEnvironment): PublicSupabaseConfig {
  const url = env.VITE_SUPABASE_URL?.trim() ?? '';
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';

  if (publishableKey && !isPublicKey(publishableKey)) {
    return {
      status: 'invalid',
      message: 'Нужен публичный ключ Supabase (publishable или legacy anon). Секретный ключ использовать нельзя.',
    };
  }

  if (url) {
    try {
      const parsed = new URL(url);
      const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      if (parsed.username || parsed.password || parsed.search || parsed.hash ||
          !(parsed.protocol === 'https:' || (isLocal && parsed.protocol === 'http:'))) {
        throw new Error('Invalid URL');
      }
    } catch {
      return {
        status: 'invalid',
        message: 'Проверьте адрес Supabase. Укажите HTTPS-адрес проекта без логина, пароля и параметров запроса. Для localhost разрешён HTTP.',
      };
    }
  }

  if (!url || !publishableKey) {
    return {
      status: 'missing',
      message: 'Добавьте URL проекта и публичный ключ Supabase в .env.local по образцу .env.example.',
    };
  }

  return { status: 'ready', url, publishableKey };
}
