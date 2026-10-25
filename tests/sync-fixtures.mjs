// Isolated test data only. Nothing in this module is imported by the app or sync jobs.
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE_URL } from '../scripts/sync-market.mjs';
import { HISTORY_SOURCE, aggregateHistory } from '../scripts/sync-history.mjs';

export const NOW = '2026-10-25T13:00:00.000Z';
export const clock = () => new Date(NOW);
export const snapshot = () => ({
  _meta: { source: 'https://roseutils.com/market', date: '2026-10-24',
    fetchedAt: '2026-10-24T08:00:51.920Z', mapId: 'city_of_junon_polis' },
  items: [['Test fixture item', null]],
  stalls: [['Test fixture shop', 5600, 5300, '2026-10-24T06:17:11.000Z', [[0, 100, 0, 0]]]],
});
export const row = (id = 1, overrides = {}) => ({
  id, item_id: 'test-fixture-item', item: { id: 'test-fixture-item', name: 'Test fixture item' },
  server_id: 'rose-online', price_type: 'sell', price: 100,
  submitted_at: '2026-10-24T06:17:11.000Z', ...overrides,
});
export const history = () => aggregateHistory([row()], '2026-10-24T10:00:00.000Z');
export const status = (data, kind = 'market') => ({
  success: true, attemptedAt: '2026-10-24T10:00:00.000Z', lastSuccessAt: '2026-10-24T10:00:00.000Z',
  snapshotFetchedAt: kind === 'market' ? data._meta.fetchedAt : data.fetchedAt,
  sourceUrl: kind === 'market' ? SOURCE_URL : HISTORY_SOURCE,
});
export const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
export const read = async (dir, file) => JSON.parse(await readFile(join(dir, file), 'utf8'));
export async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rose-market-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const market = snapshot(); const prices = history();
  for (const [file, data] of Object.entries({
    'market-stalls.json': market, 'sync-status.json': status(market),
    'price-history.json': prices, 'history-status.json': status(prices, 'history'),
  })) await writeFile(join(dir, file), JSON.stringify(data));
  return dir;
}
export function page(records, pageNumber = 1) {
  const from = (pageNumber - 1) * 100 + 1;
  const to = Math.min(pageNumber * 100, records.length);
  return { data: records.slice(from - 1, to), meta: { current_page: pageNumber, per_page: 100,
    total: records.length, last_page: Math.ceil(records.length / 100), from, to } };
}
export function api(records, mutate = value => value) {
  return async url => {
    const parsed = new URL(url);
    if (parsed.searchParams.get('server_id') !== 'rose-online' || parsed.searchParams.get('days') !== '90') throw new Error('Unexpected query');
    return jsonResponse(mutate(page(records, Number(parsed.searchParams.get('page')))));
  };
}
