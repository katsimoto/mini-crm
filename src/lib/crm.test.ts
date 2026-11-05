import { describe, expect, it, vi } from 'vitest';
import { objects } from './crm';

const { range } = vi.hoisted(() => ({ range: vi.fn() }));
vi.mock('./supabase', () => {
  const query = { select: () => query, is: () => query, order: () => query, range };
  return { supabase: { from: () => query } };
});

describe('загрузка списка объектов', () => {
  it('читает все страницы, даже если PostgREST отдаёт меньше запрошенных 200 строк', async () => {
    const sites = [{ id: '1' }, { id: '2' }, { id: '3' }];
    range.mockImplementation((start: number) => ({ data: sites.slice(start, start + 2), error: null }));
    expect(await objects()).toEqual(sites);
    expect(range.mock.calls.map(([start]) => start)).toEqual([0, 2, 3]);
  });
});
