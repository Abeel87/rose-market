import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { normalizeSnapshot } from '../dist/market.js';

export const SOURCE_URL = 'https://roseonlinetoolbox.com/data/marketStalls.json';
const DATA_DIRECTORY = fileURLToPath(new URL('../dist/data/', import.meta.url));
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 25_000;

class SyncError extends Error {}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function fetchSnapshot(fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetchImpl(SOURCE_URL, {
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ROSE-Market-Sync (+https://github.com/Abeel87/rose-market)',
      },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new SyncError(`Źródło danych nie zwróciło poprawnej odpowiedzi (HTTP ${response.status}).`);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
      await response.body.cancel();
      throw new SyncError('Odpowiedź źródła przekracza dozwolony rozmiar.');
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new SyncError('Odpowiedź źródła przekracza dozwolony rozmiar.');
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new SyncError('Źródło danych nie zwróciło poprawnego pliku JSON.');
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Refresh only the provider snapshot; never replace its observation timestamps. */
export async function syncMarket({
  dataDirectory = DATA_DIRECTORY,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
} = {}) {
  const snapshotPath = join(dataDirectory, 'market-stalls.json');
  const statusPath = join(dataDirectory, 'sync-status.json');
  const attemptedAt = clock().toISOString();
  const [previousSnapshot, previousStatus] = await Promise.all([
    readJsonOrNull(snapshotPath),
    readJsonOrNull(statusPath),
  ]);
  const previousFetchedAt = timestamp(previousSnapshot?._meta?.fetchedAt);
  let previous = null;
  try { previous = normalizeSnapshot(previousSnapshot); } catch { /* A valid download can repair a bad local copy. */ }
  const status = {
    attemptedAt,
    success: false,
    lastSuccessAt: timestamp(previousStatus?.lastSuccessAt),
    snapshotFetchedAt: previousFetchedAt,
    sourceUrl: SOURCE_URL,
    dataChanged: null,
    latestObservationAt: previous?.stats.lastSeenAt ?? null,
  };

  try {
    const incoming = await fetchSnapshot(fetchImpl);
    let normalized;
    try {
      normalized = normalizeSnapshot(incoming);
    } catch {
      throw new SyncError('Odrzucono dane o niepoprawnym formacie.');
    }
    if (!normalized.stats.items || !normalized.stats.stalls || !normalized.stats.offers) {
      throw new SyncError('Odrzucono pustą kopię danych; zachowano poprzedni plik.');
    }
    const incomingFetchedAt = timestamp(incoming?._meta?.fetchedAt);
    if (!incomingFetchedAt) {
      throw new SyncError('Źródło nie podaje poprawnej daty pobrania danych.');
    }
    if (Date.parse(incomingFetchedAt) > Date.parse(attemptedAt) + 300_000
      || Date.parse(normalized.stats.lastSeenAt) > Date.parse(incomingFetchedAt) + 300_000) {
      throw new SyncError('Źródło zawiera daty z przyszłości; zachowano poprzedni plik.');
    }
    if (previous && previousFetchedAt && Date.parse(incomingFetchedAt) < Date.parse(previousFetchedAt)) {
      throw new SyncError('Źródło zwróciło starszą kopię danych; zachowano poprzedni plik.');
    }

    // Write the raw provider data, including its original _meta and seenAt values.
    await writeJsonAtomically(snapshotPath, incoming);
    status.success = true;
    status.lastSuccessAt = attemptedAt;
    status.snapshotFetchedAt = incomingFetchedAt;
    status.dataChanged = !previous || !isDeepStrictEqual(
      [previousSnapshot.items, previousSnapshot.stalls], [incoming.items, incoming.stalls]);
    status.latestObservationAt = normalized.stats.lastSeenAt;
  } catch (error) {
    status.error = error instanceof SyncError
      ? error.message
      : 'Nie udało się odświeżyć danych. Dostępna kopia pozostaje bez zmian.';
  }

  await writeJsonAtomically(statusPath, status);
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const status = await syncMarket();
    if (status.success) {
      console.log(`Dane pobrane poprawnie (${status.dataChanged ? 'zmienione dane' : 'dane bez zmian'}). Data kopii źródłowej: ${status.snapshotFetchedAt}; ostatnia obserwacja: ${status.latestObservationAt}`);
    } else {
      console.error(status.error);
      process.exitCode = 1;
    }
  } catch {
    console.error('Nie udało się zapisać statusu odświeżenia danych.');
    process.exitCode = 1;
  }
}
