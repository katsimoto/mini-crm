import { createClient } from '@supabase/supabase-js';
import { readPublicSupabaseConfig } from './config';

export const supabaseConfig = readPublicSupabaseConfig({
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
});

// Missing configuration must not crash the configuration screen or require fake data.
export const supabase = supabaseConfig.status === 'ready'
  ? createClient(supabaseConfig.url, supabaseConfig.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null;
