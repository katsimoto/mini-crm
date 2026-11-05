import { describe, expect, it } from 'vitest';
import { readPublicSupabaseConfig } from './config';

const publicEnv = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_placeholder',
};
const fakeJwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role }))}.placeholder`;

describe('public configuration', () => {
  it('reports missing configuration when no credentials are provided', () => {
    expect(readPublicSupabaseConfig({}).status).toBe('missing');
  });

  it('accepts public keys, including legacy anon JWTs', () => {
    expect(readPublicSupabaseConfig(publicEnv).status).toBe('ready');
    expect(readPublicSupabaseConfig({
      ...publicEnv, VITE_SUPABASE_PUBLISHABLE_KEY: fakeJwt('anon'),
    }).status).toBe('ready');
  });

  it('rejects both forms of privileged key without echoing either', () => {
    for (const key of ['sb_secret_test_do_not_expose', fakeJwt('service_role')]) {
      const result = readPublicSupabaseConfig({ ...publicEnv, VITE_SUPABASE_PUBLISHABLE_KEY: key });
      expect(result.status).toBe('invalid');
      expect(JSON.stringify(result)).not.toContain(key);
    }
  });

  it('rejects credentials and query parameters even when the key is missing', () => {
    for (const url of ['https://user:test@example.com', 'https://example.com?key=test', 'https://example.com/#test']) {
      const result = readPublicSupabaseConfig({ VITE_SUPABASE_URL: url });
      expect(result.status).toBe('invalid');
      expect(JSON.stringify(result)).not.toContain(url);
    }
  });

  it('allows local HTTP and rejects remote HTTP or credentials embedded in a URL', () => {
    expect(readPublicSupabaseConfig({ ...publicEnv, VITE_SUPABASE_URL: 'http://127.0.0.1:54321' }).status)
      .toBe('ready');
    for (const url of ['http://example.supabase.co', 'https://user:password@example.supabase.co']) {
      expect(readPublicSupabaseConfig({ ...publicEnv, VITE_SUPABASE_URL: url }).status).toBe('invalid');
    }
  });
});
