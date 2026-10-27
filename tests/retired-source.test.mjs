import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordRetiredSource } from '../scripts/record-retired-source.mjs';
import { restorePublished } from '../scripts/published-data.mjs';
import { reportSync } from '../scripts/report-sync.mjs';
import { directory, read, jsonResponse, clock, NOW } from './sync-fixtures.mjs';

test('retirement preserves every archive byte and the last successful fetch, and is not healthy', async t => {
  const dataDirectory = await directory(t);
  const files = ['market-stalls.json', 'price-history.json'];
  const before = await Promise.all(files.map(file => readFile(join(dataDirectory, file), 'utf8')));
  const oldMarket = await read(dataDirectory, 'sync-status.json');
  const oldHistory = await read(dataDirectory, 'history-status.json');
  for (const kind of ['market', 'history']) await recordRetiredSource(kind, { dataDirectory, clock });
  const market = await read(dataDirectory, 'sync-status.json');
  const history = await read(dataDirectory, 'history-status.json');
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(dataDirectory, file), 'utf8'))), before);
  for (const [status, old] of [[market, oldMarket], [history, oldHistory]]) {
    assert.equal(status.reason, 'source_retired');
    assert.equal(status.success, false);
    assert.equal(status.dataChanged, null);
    assert.equal(status.lastSuccessAt, old.lastSuccessAt);
    assert.equal(status.snapshotFetchedAt, old.snapshotFetchedAt);
    assert.equal(status.attemptedAt, NOW);
  }
  const report = await reportSync({ dataDirectory, startedAt: NOW, marketOutcome: 'failure', historyOutcome: 'failure' });
  assert.equal(report.healthy, false);
  assert.match(report.summary, /zakończyło aktualizacje/);
  assert.doesNotMatch(report.summary, /Pobranie udane/);

  // A later clean runner must be able to restore the deployed archive/status.
  const nextDirectory = await directory(t);
  const published = Object.fromEntries(await Promise.all([...files, 'sync-status.json', 'history-status.json']
    .map(async file => [file, await read(dataDirectory, file)])));
  await restorePublished({ dataDirectory: nextDirectory,
    fetchImpl: async url => jsonResponse(published[new URL(url).pathname.split('/').at(-1)]) });
  assert.equal((await read(nextDirectory, 'sync-status.json')).reason, 'source_retired');
  assert.deepEqual(await read(nextDirectory, 'price-history.json'), published['price-history.json']);
});

test('an invalid archive cannot be given a new apparently valid retirement status', async t => {
  const dataDirectory = await directory(t);
  const before = await readFile(join(dataDirectory, 'sync-status.json'), 'utf8');
  await writeFile(join(dataDirectory, 'market-stalls.json'), '{}');
  await assert.rejects(recordRetiredSource('market', { dataDirectory, clock }));
  assert.equal(await readFile(join(dataDirectory, 'sync-status.json'), 'utf8'), before);
});

test('a clock rollback cannot overwrite the last known status', async t => {
  const dataDirectory = await directory(t);
  await recordRetiredSource('market', { dataDirectory, clock });
  const before = await readFile(join(dataDirectory, 'sync-status.json'), 'utf8');
  await assert.rejects(recordRetiredSource('market', {
    dataDirectory, clock: () => new Date('2026-10-24T10:00:00Z'),
  }));
  assert.equal(await readFile(join(dataDirectory, 'sync-status.json'), 'utf8'), before);
});
