import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readPublicSupabaseConfig } from './src/lib/config.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  // Fail BEFORE bundling: a runtime check cannot remove a secret already
  // substituted into import.meta.env by Vite.
  const allowed = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'];
  if (Object.keys(env).some(name => name.startsWith('VITE_') && !allowed.includes(name))) {
    throw new Error('Для браузера разрешены только VITE_SUPABASE_URL и VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

  const config = readPublicSupabaseConfig(env);
  if (config.status === 'invalid') {
    // Never include the provided key in an error or log.
    throw new Error(config.message);
  }

  return { plugins: [react()] };
});
