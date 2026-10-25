import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeSnapshot } from '../dist/market.js';
import { SOURCE_URL } from './sync-market.mjs';
import { HISTORY_SOURCE, validateHistory } from './sync-history.mjs';

export const PUBLISHED_URL = 'https://abeel87.github.io/rose-market/data/';
const DATA_DIRECTORY = fileURLToPath(new URL('../dist/data/', import.meta.url));
const FILES = ['market-stalls.json', 'sync-status.json', 'price-history.json', 'history-status.json'];
const MAX_BYTES = 8 * 1024 * 1024;

export function validatePair(data, status, kind) {
  const market = kind === 'market';
  const normalized = market ? normalizeSnapshot(data) : validateHistory(data);
  if (market && (!normalized.stats.items || !normalized.stats.stalls || !normalized.stats.offers)) {
    throw new Error('Empty published market snapshot.');
  }
  const fetchedAt = market ? normalized.meta.fetchedAt : normalized.fetchedAt;
  if (typeof status?.success !== 'boolean' || !Number.isFinite(Date.parse(status.attemptedAt))
    || status.sourceUrl !== (market ? SOURCE_URL : HISTORY_SOURCE)
    || Date.parse(status.snapshotFetchedAt) !== Date.parse(fetchedAt)
    || (status.lastSuccessAt !== null && !Number.isFinite(Date.parse(status.lastSuccessAt)))
    || (status.success && status.lastSuccessAt === null)) {
    throw new Error(`Inconsistent ${kind} data/status pair; refusing to replace the published data.`);
  }
  return { data, status, fetchedAt };
}

async function fetchJson(file, fetchImpl, token) {
  const url = new URL(file, PUBLISHED_URL);
  // Revalidate Pages instead of reading a CDN copy left by an older deployment.
  url.searchParams.set('refresh', token);
  const response = await fetchImpl(url.href, {
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(25_000),
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Cannot restore ${file}: HTTP ${response.status}. The existing publication must remain in place.`);
  }
  const limit = file.includes('status') ? 16_384 : MAX_BYTES;
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw new Error(`Published file exceeds the size limit: ${file}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`Published file exceeds the size limit: ${file}`);
    }
    chunks.push(value);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

/** A clean checkout is not the last successful deployment. Restore that deployment first. */
export async function restorePublished({ dataDirectory = DATA_DIRECTORY,
  fetchImpl = globalThis.fetch, token = randomUUID() } = {}) {
  const results = await Promise.allSettled(FILES.map(file => fetchJson(file, fetchImpl, token)));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const [market, marketStatus, history, historyStatus] = results.map(result => result.value);
  const published = [validatePair(market, marketStatus, 'market'), validatePair(history, historyStatus, 'history')];
  const selected = [];
  for (const [index, kind] of ['market', 'history'].entries()) {
    let local = null;
    try {
      const pair = await Promise.all(FILES.slice(index * 2, index * 2 + 2)
        .map(file => readFile(join(dataDirectory, file), 'utf8').then(JSON.parse)));
      local = validatePair(...pair, kind);
    } catch { /* The verified published copy can replace a missing/invalid checkout fallback. */ }
    if (local && Date.parse(local.fetchedAt) > Date.parse(published[index].fetchedAt)) {
      // A manual data commit may be newer. Refuse to discard either history silently.
      if (kind === 'history') throw new Error('Repository history is newer than Pages. Reconcile the two histories before publishing.');
      selected.push(local);
    } else selected.push(published[index]);
  }
  // Validate every remote file before touching any local file. A failed restoration
  // stops the workflow before upload/deploy, leaving the live site intact.
  const values = selected.flatMap(pair => [pair.data, pair.status]);
  const pending = [];
  try {
    for (const [index, file] of FILES.entries()) {
      const target = join(dataDirectory, file);
      const temporary = `${target}.${randomUUID()}.tmp`;
      pending.push([temporary, target]);
      await writeFile(temporary, `${JSON.stringify(values[index])}\n`, { flag: 'wx' });
    }
    for (const [temporary, target] of pending) await rename(temporary, target);
  } finally {
    await Promise.all(pending.map(([temporary]) => unlink(temporary).catch(() => {})));
  }
  return { marketFetchedAt: selected[0].fetchedAt, historyFetchedAt: selected[1].fetchedAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log('Restored last published data:', await restorePublished()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
