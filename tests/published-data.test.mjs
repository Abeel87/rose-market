import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { restorePublished, PUBLISHED_URL } from '../scripts/published-data.mjs';
import { syncMarket } from '../scripts/sync-market.mjs';
import { syncHistory, aggregateHistory } from '../scripts/sync-history.mjs';
import { reportSync, checkAttempt } from '../scripts/report-sync.mjs';
import { syncLabel } from '../dist/data-status.js';
import { directory, snapshot, row, status, jsonResponse, read, clock, NOW } from './sync-fixtures.mjs';

function published() {
  const market = snapshot();
  market._meta.fetchedAt = '2026-10-25T10:00:00.000Z';
  market.stalls[0][3] = '2026-10-25T09:00:00.000Z';
  market.stalls[0][4][0][1] = 120;
  const history = JSON.parse(JSON.stringify(aggregateHistory([row(), row(2, { submitted_at: '2026-10-25T09:00:00.000Z', price: 120 })], '2026-10-25T10:00:00.000Z')));
  return {
    'market-stalls.json': market, 'sync-status.json': { ...status(market), attemptedAt: '2026-10-25T10:00:00.000Z', lastSuccessAt: '2026-10-25T10:00:00.000Z' },
    'price-history.json': history, 'history-status.json': { ...status(history, 'history'), attemptedAt: '2026-10-25T10:00:00.000Z', lastSuccessAt: '2026-10-25T10:00:00.000Z' },
  };
}
const serve = files => async (url, options) => {
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error');
  assert.ok(url.startsWith(PUBLISHED_URL));
  assert.ok(new URL(url).searchParams.get('refresh'));
  return jsonResponse(files[new URL(url).pathname.split('/').at(-1)]);
};

test('a clean checkout restores the last deployment, and source failures preserve its newer data', async t => {
  const dataDirectory = await directory(t);
  const live = published();
  await restorePublished({ dataDirectory, fetchImpl: serve(live) });
  const restoredMarket = await readFile(join(dataDirectory, 'market-stalls.json'), 'utf8');
  const restoredHistory = await readFile(join(dataDirectory, 'price-history.json'), 'utf8');
  const fetchImpl = async () => { throw new Error('provider offline'); };
  const market = await syncMarket({ dataDirectory, clock, fetchImpl });
  const prices = await syncHistory({ dataDirectory, clock, fetchImpl });
  assert.equal(market.success, false);
  assert.equal(prices.success, false);
  assert.equal(market.lastSuccessAt, live['sync-status.json'].lastSuccessAt);
  assert.equal(prices.lastSuccessAt, live['history-status.json'].lastSuccessAt);
  assert.equal(await readFile(join(dataDirectory, 'market-stalls.json'), 'utf8'), restoredMarket);
  assert.equal(await readFile(join(dataDirectory, 'price-history.json'), 'utf8'), restoredHistory);
  const result = await reportSync({ dataDirectory, startedAt: NOW, marketOutcome: 'failure', historyOutcome: 'failure' });
  assert.equal(result.healthy, false);
  assert.match(result.summary, /2026-10-25T09:00:00.000Z/);
  assert.match(result.summary, /Błąd pobrania/);

  // Next runner starts from the same old checkout, then restores the fallback
  // deployment including its failure statuses, without losing successful dates.
  const nextDirectory = await directory(t);
  const nextLive = Object.fromEntries(await Promise.all(Object.keys(live).map(async file => [file, await read(dataDirectory, file)])));
  await restorePublished({ dataDirectory: nextDirectory, fetchImpl: serve(nextLive) });
  assert.deepEqual(await read(nextDirectory, 'market-stalls.json'), live['market-stalls.json']);
  assert.deepEqual(await read(nextDirectory, 'price-history.json'), live['price-history.json']);
});

test('rollback from the provider is rejected against the deployed baseline, not the old checkout', async t => {
  const dataDirectory = await directory(t);
  const live = published();
  await restorePublished({ dataDirectory, fetchImpl: serve(live) });
  const result = await syncMarket({ dataDirectory, clock, fetchImpl: async () => jsonResponse(snapshot()) });
  assert.equal(result.success, false);
  assert.match(result.error, /starszą/);
  assert.deepEqual(await read(dataDirectory, 'market-stalls.json'), live['market-stalls.json']);
});

for (const [name, customize] of [
  ['HTTP error', () => async () => new Response('offline', { status: 503 })],
  ['missing published file', () => async () => new Response('not found', { status: 404 })],
  ['truncated history', live => { live['price-history.json'] = { items: {} }; return serve(live); }],
  ['mismatched data and status', live => { live['history-status.json'].snapshotFetchedAt = NOW; return serve(live); }],
  ['oversized file', () => async () => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } })],
]) {
  test(`${name} stops restoration before overwriting any checkout file`, async t => {
    const dataDirectory = await directory(t);
    const live = published();
    const files = Object.keys(live);
    const before = await Promise.all(files.map(file => readFile(join(dataDirectory, file), 'utf8')));
    await assert.rejects(restorePublished({ dataDirectory, fetchImpl: customize(live) }));
    assert.deepEqual(await Promise.all(files.map(file => readFile(join(dataDirectory, file), 'utf8'))), before);
  });
}

test('a newer manually committed market snapshot is not rolled back during restore', async t => {
  const dataDirectory = await directory(t);
  const live = published();
  const local = structuredClone(live['market-stalls.json']); local._meta.fetchedAt = NOW;
  await writeFile(join(dataDirectory, 'market-stalls.json'), JSON.stringify(local));
  await writeFile(join(dataDirectory, 'sync-status.json'), JSON.stringify(status(local)));
  await restorePublished({ dataDirectory, fetchImpl: serve(live) });
  assert.deepEqual(await read(dataDirectory, 'market-stalls.json'), local);
});

test('a newer repository history requires reconciliation instead of discarding either history', async t => {
  const dataDirectory = await directory(t);
  const live = published();
  const local = structuredClone(live['price-history.json']); local.fetchedAt = NOW;
  await writeFile(join(dataDirectory, 'price-history.json'), JSON.stringify(local));
  await writeFile(join(dataDirectory, 'history-status.json'), JSON.stringify(status(local, 'history')));
  await assert.rejects(restorePublished({ dataDirectory, fetchImpl: serve(live) }), /Reconcile/);
  assert.deepEqual(await read(dataDirectory, 'price-history.json'), local);
});

test('stale and contradictory statuses cannot masquerade as a successful current run', () => {
  const good = { success: true, dataChanged: false, attemptedAt: NOW };
  assert.doesNotThrow(() => checkAttempt(good, 'success', NOW));
  assert.throws(() => checkAttempt(good, 'failure', NOW));
  assert.throws(() => checkAttempt(good, 'skipped', NOW));
  assert.throws(() => checkAttempt({ ...good, attemptedAt: '2026-10-24T10:00:00Z' }, 'success', NOW));
  assert.throws(() => checkAttempt({ ...good, attemptedAt: undefined }, 'success', NOW));
  assert.throws(() => checkAttempt({ ...good, dataChanged: undefined }, 'success', NOW));
  assert.doesNotThrow(() => checkAttempt({ success: false, dataChanged: null, attemptedAt: NOW }, 'failure', NOW));
});

test('UI distinguishes a changed download, unchanged source, failed fetch and legacy status', () => {
  assert.match(syncLabel({ success: true, dataChanged: false }), /bez zmian/);
  assert.match(syncLabel({ success: true, dataChanged: true }), /zmienione dane/);
  assert.match(syncLabel({ success: false, dataChanged: true }), /błąd/);
  assert.match(syncLabel({ success: true }), /sprawdź datę obserwacji/);
  assert.match(syncLabel(null), /niedostępny/);
});
