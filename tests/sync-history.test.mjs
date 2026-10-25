import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syncHistory, aggregateHistory, canonicalName } from '../scripts/sync-history.mjs';
import { directory, row, read, clock, NOW, api, jsonResponse, page } from './sync-fixtures.mjs';

test('complete pagination keeps buy/sell separate and repeated imports do not double counts', async t => {
  const dataDirectory = await directory(t);
  const records = Array.from({ length: 101 }, (_, index) => row(index + 1, { price: index + 1, price_type: index === 100 ? 'buy' : 'sell' }));
  const visited = [];
  const fetchImpl = async url => { visited.push(Number(new URL(url).searchParams.get('page'))); return api(records)(url); };
  const first = await syncHistory({ dataDirectory, clock, fetchImpl });
  assert.equal(first.success, true);
  assert.equal(first.dataChanged, true);
  assert.equal(first.recordCount, 101);
  assert.equal(first.latestObservationDate, '2026-10-24');
  const data = await read(dataDirectory, 'price-history.json');
  assert.deepEqual(data.items['test fixture item'].points, [{ date: '2026-10-24', sellMin: 1, sellMax: 100,
    buyMin: 101, buyMax: 101, sellCount: 100, buyCount: 1 }]);
  const again = await syncHistory({ dataDirectory, clock, fetchImpl });
  assert.equal(again.success, true);
  assert.equal(again.dataChanged, false);
  assert.deepEqual(await read(dataDirectory, 'price-history.json'), data);
  assert.deepEqual(visited, [1, 2, 1, 2]);
});

test('unchanged history keeps the actual days while recording a successful download', async t => {
  const dataDirectory = await directory(t);
  const previous = await read(dataDirectory, 'price-history.json');
  const result = await syncHistory({ dataDirectory, clock, fetchImpl: api([row()]) });
  assert.equal(result.success, true);
  assert.equal(result.dataChanged, false);
  assert.equal(result.snapshotFetchedAt, NOW);
  assert.equal(result.latestObservationDate, '2026-10-24');
  assert.deepEqual((await read(dataDirectory, 'price-history.json')).items, previous.items);
});

test('merging retains earlier real days and the missing market side without inventing gaps', () => {
  const old = aggregateHistory([row(1, { submitted_at: '2026-10-20T01:00:00Z' }), row(2, { price_type: 'buy', price: 70 })], NOW);
  const next = aggregateHistory([row(3, { price: 90 })], NOW, old);
  const points = next.items[canonicalName(row().item.name)].points;
  assert.deepEqual(points.map(point => point.date), ['2026-10-20', '2026-10-24']);
  assert.equal(points[1].buyMin, 70);
  assert.equal(points[1].sellMin, 90);
  assert.equal(points[1].sellCount, 1);
});

const many = () => Array.from({ length: 101 }, (_, index) => row(index + 1));
for (const [name, fetchImpl] of [
  ['network failure', async () => { throw new TypeError('fetch failed'); }],
  ['HTTP 503', async () => new Response('error', { status: 503 })],
  ['long rate limit', async () => new Response('', { status: 429, headers: { 'retry-after': '3600' } })],
  ['invalid JSON', async () => new Response('not json')],
  ['empty response', api([])],
  ['partial page', api(many(), data => { if (data.meta.current_page === 2) data.data = []; return data; })],
  ['changed pagination', api(many(), data => { if (data.meta.current_page === 2) data.meta.total = 102; return data; })],
  ['duplicate IDs', api(many().map(record => ({ ...record, id: 1 })))],
  ['wrong server', api([row(1, { server_id: 'another-server' })])],
  ['ambiguous item identity', api([row(), row(2, { item_id: 'different', item: { id: 'different', name: row().item.name } })])],
  ['invalid price', api([row(1, { price: -1 })])],
  ['invalid side', api([row(1, { price_type: 'unknown' })])],
  ['invalid date', api([row(1, { submitted_at: '2026-02-30T06:17:11Z' })])],
  ['future quote', api([row(1, { submitted_at: '2099-10-25T06:17:11Z' })])],
  ['oversized page', async () => new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } })],
]) {
  test(`${name} cannot replace complete history or advance lastSuccessAt`, async t => {
    const dataDirectory = await directory(t);
    const before = await readFile(join(dataDirectory, 'price-history.json'), 'utf8');
    const previous = await read(dataDirectory, 'history-status.json');
    const result = await syncHistory({ dataDirectory, clock, fetchImpl });
    assert.equal(result.success, false);
    assert.equal(result.dataChanged, null);
    assert.equal(result.lastSuccessAt, previous.lastSuccessAt);
    assert.equal(result.snapshotFetchedAt, previous.snapshotFetchedAt);
    assert.equal(result.latestObservationDate, '2026-10-24');
    assert.equal(await readFile(join(dataDirectory, 'price-history.json'), 'utf8'), before);
  });
}

test('a short HTTP 429 is retried once and then a complete result is accepted', async t => {
  const dataDirectory = await directory(t);
  let calls = 0;
  const result = await syncHistory({ dataDirectory, clock, fetchImpl: async () => ++calls === 1
    ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : jsonResponse(page([row()])) });
  assert.equal(result.success, true);
  assert.equal(calls, 2);
});
