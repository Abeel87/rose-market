import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { syncMarket } from '../scripts/sync-market.mjs';
import { directory, snapshot, read, jsonResponse, clock, NOW } from './sync-fixtures.mjs';

test('same source snapshot advances download status without inventing fresh observations', async t => {
  const dataDirectory = await directory(t);
  const source = snapshot();
  const result = await syncMarket({ dataDirectory, clock, fetchImpl: async () => jsonResponse(source) });
  assert.equal(result.success, true);
  assert.equal(result.dataChanged, false);
  assert.equal(result.lastSuccessAt, NOW);
  assert.equal(result.snapshotFetchedAt, source._meta.fetchedAt);
  assert.equal(result.latestObservationAt, source.stalls[0][3]);
  assert.deepEqual(await read(dataDirectory, 'market-stalls.json'), source);
});

test('new snapshot replaces the old one and retains the exact provider timestamps and prices', async t => {
  const dataDirectory = await directory(t);
  const source = snapshot();
  source._meta.fetchedAt = '2026-10-25T10:00:00.000Z';
  source.stalls[0][3] = '2026-10-25T09:00:00.000Z';
  source.stalls[0][4][0][1] = 110;
  const result = await syncMarket({ dataDirectory, clock, fetchImpl: async () => jsonResponse(source) });
  assert.equal(result.success, true);
  assert.equal(result.dataChanged, true);
  assert.equal(result.latestObservationAt, source.stalls[0][3]);
  assert.deepEqual(await read(dataDirectory, 'market-stalls.json'), source);
});

test('a newer provider fetch time alone is not a new observation', async t => {
  const dataDirectory = await directory(t);
  const source = snapshot(); source._meta.fetchedAt = '2026-10-25T10:00:00.000Z';
  const result = await syncMarket({ dataDirectory, clock, fetchImpl: async () => jsonResponse(source) });
  assert.equal(result.success, true);
  assert.equal(result.dataChanged, false);
  assert.equal(result.latestObservationAt, snapshot().stalls[0][3]);
});

const malformed = change => async () => { const data = snapshot(); change(data); return jsonResponse(data); };
for (const [name, fetchImpl] of [
  ['network error', async () => { throw new TypeError('fetch failed'); }],
  ['HTTP failure', async () => new Response('unavailable', { status: 503 })],
  ['invalid JSON', async () => new Response('<html>error</html>')],
  ['empty snapshot', malformed(data => { data.items = []; data.stalls = []; })],
  ['invalid price', malformed(data => { data.stalls[0][4][0][1] = -1; })],
  ['older snapshot', malformed(data => { data._meta.fetchedAt = '2026-10-24T07:00:00.000Z'; })],
  ['future snapshot', malformed(data => { data._meta.fetchedAt = '2099-10-24T08:00:00.000Z'; })],
  ['future observation', malformed(data => { data.stalls[0][3] = '2099-10-24T08:00:00.000Z'; })],
  ['oversized declaration', async () => new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } })],
  ['oversized stream', async () => new Response(' '.repeat(8 * 1024 * 1024 + 1))],
]) {
  test(`${name} preserves the previous market bytes and last successful fetch`, async t => {
    const dataDirectory = await directory(t);
    const before = await readFile(join(dataDirectory, 'market-stalls.json'), 'utf8');
    const previous = await read(dataDirectory, 'sync-status.json');
    const result = await syncMarket({ dataDirectory, clock, fetchImpl });
    assert.equal(result.success, false);
    assert.equal(result.dataChanged, null);
    assert.equal(result.attemptedAt, NOW);
    assert.equal(result.lastSuccessAt, previous.lastSuccessAt);
    assert.equal(result.snapshotFetchedAt, previous.snapshotFetchedAt);
    assert.equal(await readFile(join(dataDirectory, 'market-stalls.json'), 'utf8'), before);
    assert.equal((await readdir(dataDirectory)).some(file => file.endsWith('.tmp')), false);
    assert.deepEqual(await read(dataDirectory, 'sync-status.json'), result);
  });
}

test('an invalid local copy with a bogus future date does not block recovery', async t => {
  const dataDirectory = await directory(t);
  await writeFile(join(dataDirectory, 'market-stalls.json'), JSON.stringify({ _meta: { fetchedAt: '2099-01-01T00:00:00Z' } }));
  const result = await syncMarket({ dataDirectory, clock, fetchImpl: async () => jsonResponse(snapshot()) });
  assert.equal(result.success, true);
  assert.deepEqual(await read(dataDirectory, 'market-stalls.json'), snapshot());
});
