import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, copyFile, cp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordRetiredSource } from '../scripts/record-retired-source.mjs';
import { restorePublished } from '../scripts/published-data.mjs';
import { reportSync, checkAttempt } from '../scripts/report-sync.mjs';
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
  const report = await reportSync({ dataDirectory, startedAt: NOW, marketOutcome: 'success', historyOutcome: 'success' });
  assert.equal(report.healthy, false);
  assert.match(report.summary, /zakończyło aktualizacje/);
  assert.match(report.summary, /Archiwum zweryfikowane i zachowane/);
  assert.doesNotMatch(report.summary, /Pobranie udane|opublikowan/i);

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

test('a retired source requires a successful recording operation without a successful live status', () => {
  const retired = { reason: 'source_retired', success: false, dataChanged: null, attemptedAt: NOW };
  assert.doesNotThrow(() => checkAttempt(retired, 'success', NOW));
  for (const outcome of ['failure', 'skipped', 'cancelled', undefined]) {
    assert.throws(() => checkAttempt(retired, outcome, NOW), /inconsistent status/);
  }
  for (const invalid of [
    null,
    undefined,
    { ...retired, attemptedAt: '2026-10-24T10:00:00Z' },
    { ...retired, attemptedAt: undefined },
    { ...retired, success: true },
    { ...retired, success: undefined },
    { ...retired, dataChanged: true },
    { ...retired, dataChanged: false },
    { ...retired, dataChanged: undefined },
  ]) assert.throws(() => checkAttempt(invalid, 'success', NOW), /inconsistent status/);
});

// Run the actual entrypoints against fixture files in their own module tree.
// No production file or source endpoint is used by these subprocesses.
async function isolatedCli(t) {
  const root = await mkdtemp(join(tmpdir(), 'rose-market-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = join(root, 'dist/data');
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const file of [
    'scripts/record-retired-source.mjs', 'scripts/report-sync.mjs',
    'scripts/published-data.mjs', 'scripts/sync-market.mjs',
    'scripts/sync-history.mjs', 'dist/market.js', 'package.json',
  ]) await copyFile(new URL(`../${file}`, import.meta.url), join(root, file));
  await cp(await directory(t), dataDirectory, { recursive: true });
  return {
    dataDirectory,
    run(script, args = [], { readOnly = false, env = {} } = {}) {
      return spawnSync(process.execPath, [
        // Denying writes produces a real filesystem permission error even when
        // the test runner itself is root (where chmod alone would not suffice).
        ...(readOnly ? ['--permission', '--allow-fs-read=*'] : []),
        join(root, 'scripts', script), ...args,
      ], { cwd: root, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env } });
    },
  };
}

test('CLI records both archives successfully while a live-health check remains unsuccessful', async t => {
  const { dataDirectory, run } = await isolatedCli(t);
  const files = ['market-stalls.json', 'price-history.json'];
  const before = await Promise.all(files.map(file => readFile(join(dataDirectory, file), 'utf8')));
  const previous = await Promise.all(['sync-status.json', 'history-status.json'].map(file => read(dataDirectory, file)));
  const startedAt = new Date().toISOString();
  for (const [index, kind] of ['market', 'history'].entries()) {
    const result = run('record-retired-source.mjs', [kind]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Zapisano status zweryfikowanego archiwum/);
    assert.doesNotMatch(result.stdout, /opublikowan/i);
    const status = await read(dataDirectory, kind === 'market' ? 'sync-status.json' : 'history-status.json');
    assert.equal(status.reason, 'source_retired');
    assert.equal(status.success, false);
    assert.equal(status.dataChanged, null);
    assert.equal(status.lastSuccessAt, previous[index].lastSuccessAt);
    assert.equal(status.snapshotFetchedAt, previous[index].snapshotFetchedAt);
  }
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(dataDirectory, file), 'utf8'))), before);
  const env = { REFRESH_STARTED_AT: startedAt, SYNC_OUTCOME: 'success', HISTORY_OUTCOME: 'success' };
  const report = run('report-sync.mjs', [], { env });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /Archiwum zweryfikowane i zachowane/);
  assert.doesNotMatch(report.stdout, /Pobranie udane|opublikowan/i);
  assert.equal(run('report-sync.mjs', ['--require-success'], { env }).status, 1);
  assert.equal(run('report-sync.mjs', [], { env: { ...env, SYNC_OUTCOME: 'failure' } }).status, 1);
});

for (const kind of ['market', 'history']) {
  test(`${kind} CLI fails validation without replacing the previous status`, async t => {
    const { dataDirectory, run } = await isolatedCli(t);
    const statusFile = kind === 'market' ? 'sync-status.json' : 'history-status.json';
    const dataFile = kind === 'market' ? 'market-stalls.json' : 'price-history.json';
    const before = await readFile(join(dataDirectory, statusFile), 'utf8');
    await writeFile(join(dataDirectory, dataFile), '{}');
    const result = run('record-retired-source.mjs', [kind]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Nie udało się zweryfikować archiwum/);
    assert.equal(await readFile(join(dataDirectory, statusFile), 'utf8'), before);
  });

  test(`${kind} CLI fails a real write denial and preserves archive and status bytes`, async t => {
    const { dataDirectory, run } = await isolatedCli(t);
    const files = ['market-stalls.json', 'price-history.json', 'sync-status.json', 'history-status.json'];
    const before = await Promise.all(files.map(file => readFile(join(dataDirectory, file), 'utf8')));
    const result = run('record-retired-source.mjs', [kind], { readOnly: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Nie udało się zweryfikować archiwum/);
    assert.deepEqual(await Promise.all(files.map(file => readFile(join(dataDirectory, file), 'utf8'))), before);
  });
}
