import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const HISTORY_SOURCE = 'https://api.roseonlinetoolbox.com/api/v1/prices';
const DATA_DIRECTORY = fileURLToPath(new URL('../dist/data/', import.meta.url));
const PER_PAGE = 100;
const MAX_PAGES = 100;
const MAX_RECORDS = 10_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;
const TOTAL_TIMEOUT_MS = 5 * 60_000;
const HISTORY_DAYS = 90;
const DAY_MS = 86_400_000;

class HistoryError extends Error {}

export function canonicalName(name) {
  return name.normalize('NFC').trim().toLowerCase();
}

function fail(message = 'Źródło historii zwróciło niepoprawne lub niekompletne dane.') {
  throw new HistoryError(message);
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0
    && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function isTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  return Boolean(match && isDay(match[1]) && +match[2] < 24 && +match[3] < 60
    && +match[4] < 60 && Number.isFinite(Date.parse(value)));
}

function isPrice(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function emptyPoint(date) {
  return { date, sellMin: null, sellMax: null, buyMin: null, buyMax: null, sellCount: 0, buyCount: 0 };
}

/** Validate the public history file without inventing missing days or prices. */
export function validateHistory(value) {
  if (!value || typeof value !== 'object' || value.version !== 1
    || value.source !== HISTORY_SOURCE || !isTimestamp(value.fetchedAt)
    || !value.items || typeof value.items !== 'object' || Array.isArray(value.items)) fail();
  const entries = Object.entries(value.items);
  if (!entries.length || entries.length > MAX_RECORDS) fail();
  for (const [key, item] of entries) {
    if (!item || !text(item.name) || canonicalName(item.name) !== key
      || !text(item.sourceItemId) || !Array.isArray(item.points)
      || !item.points.length || item.points.length > HISTORY_DAYS) fail();
    let previousDate = '';
    for (const point of item.points) {
      if (!point || !isDay(point.date) || point.date <= previousDate) fail();
      previousDate = point.date;
      for (const type of ['sell', 'buy']) {
        const count = point[`${type}Count`];
        const min = point[`${type}Min`];
        const max = point[`${type}Max`];
        if (!Number.isSafeInteger(count) || count < 0 || count > MAX_RECORDS) fail();
        if (count === 0 ? min !== null || max !== null : !isPrice(min) || !isPrice(max) || min > max) fail();
      }
      if (!point.sellCount && !point.buyCount) fail();
    }
  }
  return value;
}

function validatePage(payload, page, expected = null) {
  const meta = payload?.meta;
  if (!meta || !Array.isArray(payload.data) || meta.current_page !== page || meta.per_page !== PER_PAGE
    || !Number.isSafeInteger(meta.total) || meta.total < 1 || meta.total > MAX_RECORDS
    || !Number.isSafeInteger(meta.last_page) || meta.last_page < 1 || meta.last_page > MAX_PAGES
    || meta.last_page !== Math.ceil(meta.total / PER_PAGE)) fail();
  if (expected && (meta.total !== expected.total || meta.last_page !== expected.last_page)) {
    fail('Lista cen zmieniła się podczas pobierania. Zachowano poprzednią historię.');
  }
  const from = (page - 1) * PER_PAGE + 1;
  const to = Math.min(page * PER_PAGE, meta.total);
  if (page > meta.last_page || meta.from !== from || meta.to !== to || payload.data.length !== to - from + 1) fail();
  return payload;
}

function validateRecord(row) {
  if (!row || !Number.isSafeInteger(row.id) || row.id < 1
    || row.server_id !== 'rose-online' || (row.server && row.server.id !== 'rose-online')
    || !['sell', 'buy'].includes(row.price_type) || !isPrice(row.price)
    || !isTimestamp(row.submitted_at) || !row.item || !text(row.item.name)
    || !text(row.item.id) || row.item_id !== row.item.id) fail();
  return row;
}

function retryDelay(value) {
  if (!value) return 3_000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(delay) || delay > 30_000) return null;
  return Math.max(1_000, delay);
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function readBoundedJson(response) {
  if (!response.body) fail();
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAGE_BYTES) {
    await response.body.cancel();
    fail('Odpowiedź źródła historii przekracza dozwolony rozmiar.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel();
      fail('Odpowiedź źródła historii przekracza dozwolony rozmiar.');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    fail('Źródło historii nie zwróciło poprawnego pliku JSON.');
  }
}

async function fetchPage(page, fetchImpl, requestState, signal) {
  const url = new URL(HISTORY_SOURCE);
  url.search = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page), days: String(HISTORY_DAYS), server_id: 'rose-online' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = requestState.nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait, signal);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await fetchImpl(url.href, {
        signal: AbortSignal.any([signal, controller.signal]),
        redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json', 'User-Agent': 'ROSE-Market-History (+https://github.com/Abeel87/rose-market)' },
      });
      if (response.status === 429) {
        const delay = retryDelay(response.headers.get('retry-after'));
        await response.body?.cancel();
        if (attempt || requestState.retries >= 2 || delay === null) {
          fail('Źródło historii ograniczyło liczbę zapytań. Zachowano poprzednią kopię.');
        }
        requestState.retries++;
        requestState.nextAllowedAt = Math.max(requestState.nextAllowedAt, Date.now() + delay);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        fail(`Źródło historii nie zwróciło poprawnej odpowiedzi (HTTP ${response.status}).`);
      }
      return await readBoundedJson(response);
    } finally {
      clearTimeout(timeout);
    }
  }
  fail();
}

/** Full, bounded pagination. No partial page set is ever published. */
async function fetchRecords(fetchImpl, onProgress) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  timeout.unref?.();
  const requestState = { retries: 0, nextAllowedAt: 0 };
  try {
    const first = validatePage(await fetchPage(1, fetchImpl, requestState, controller.signal), 1);
    const pages = [first];
    onProgress({ completed: 1, total: first.meta.last_page });
    for (let page = 2; page <= first.meta.last_page; page += 2) {
      const indices = [page, page + 1].filter(index => index <= first.meta.last_page);
      const batch = await Promise.all(indices.map(async index =>
        validatePage(await fetchPage(index, fetchImpl, requestState, controller.signal), index, first.meta)));
      pages.push(...batch);
      onProgress({ completed: pages.length, total: first.meta.last_page });
    }
    const records = pages.flatMap(page => page.data.map(validateRecord));
    if (records.length !== first.meta.total || new Set(records.map(row => row.id)).size !== records.length) {
      fail('Nie udało się pobrać kompletnej, spójnej listy cen. Zachowano poprzednią historię.');
    }
    return records;
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}

/** Separate buy/sell quotes by submitted_at UTC day; counts are quote records. */
export function aggregateHistory(records, fetchedAt, previous = null) {
  if (!isTimestamp(fetchedAt)) fail();
  const today = fetchedAt.slice(0, 10);
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - (HISTORY_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const groups = new Map();
  const identities = new Map();
  for (const raw of records) {
    const row = validateRecord(raw);
    if (Date.parse(row.submitted_at) > Date.parse(fetchedAt) + 5 * 60_000) fail('Źródło historii zawiera ceny z przyszłości.');
    const name = row.item.name.normalize('NFC').trim();
    const key = canonicalName(name);
    if (identities.has(key) && identities.get(key) !== row.item.id) fail('Nazwy przedmiotów w historii są niejednoznaczne.');
    identities.set(key, row.item.id);
    const date = new Date(row.submitted_at).toISOString().slice(0, 10);
    if (date < cutoff || date > today) continue;
    if (!groups.has(key)) groups.set(key, { name, sourceItemId: row.item.id, points: new Map() });
    const item = groups.get(key);
    if (!item.points.has(date)) item.points.set(date, emptyPoint(date));
    const point = item.points.get(date);
    const minKey = `${row.price_type}Min`;
    const maxKey = `${row.price_type}Max`;
    point[minKey] = point[minKey] === null ? row.price : Math.min(point[minKey], row.price);
    point[maxKey] = point[maxKey] === null ? row.price : Math.max(point[maxKey], row.price);
    point[`${row.price_type}Count`]++;
  }
  if (!groups.size) fail('Źródło nie zawiera historii cen z ostatnich 90 dni.');

  if (previous) {
    validateHistory(previous);
    for (const [key, oldItem] of Object.entries(previous.items)) {
      if (groups.has(key) && groups.get(key).sourceItemId !== oldItem.sourceItemId) continue;
      for (const oldPoint of oldItem.points) {
        if (oldPoint.date < cutoff || oldPoint.date > today) continue;
        if (!groups.has(key)) groups.set(key, { name: oldItem.name, sourceItemId: oldItem.sourceItemId, points: new Map() });
        const item = groups.get(key);
        if (!item.points.has(oldPoint.date)) item.points.set(oldPoint.date, { ...oldPoint });
        else {
          const point = item.points.get(oldPoint.date);
          // Replace overlapping day/type buckets instead of double-counting quotes.
          // Keep a prior type only when the provider no longer returns that bucket.
          for (const type of ['sell', 'buy']) {
            if (!point[`${type}Count`] && oldPoint[`${type}Count`]) {
              for (const suffix of ['Min', 'Max', 'Count']) point[`${type}${suffix}`] = oldPoint[`${type}${suffix}`];
            }
          }
        }
      }
    }
  }

  const items = Object.create(null);
  for (const [key, item] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    items[key] = { name: item.name, sourceItemId: item.sourceItemId,
      points: [...item.points.values()].sort((a, b) => a.date.localeCompare(b.date)) };
  }
  return validateHistory({ version: 1, source: HISTORY_SOURCE, fetchedAt, items });
}

async function readJsonOrNull(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function writeAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

export function latestHistoryDate(history) {
  let latest = null;
  for (const item of Object.values(history?.items ?? {})) {
    const date = item.points.at(-1)?.date;
    if (date && (!latest || date > latest)) latest = date;
  }
  return latest;
}

export async function syncHistory({ dataDirectory = DATA_DIRECTORY, fetchImpl = globalThis.fetch,
  clock = () => new Date(), onProgress = () => {} } = {}) {
  const historyPath = join(dataDirectory, 'price-history.json');
  const statusPath = join(dataDirectory, 'history-status.json');
  const [storedHistory, oldStatus] = await Promise.all([readJsonOrNull(historyPath), readJsonOrNull(statusPath)]);
  let previous = null;
  try { if (storedHistory) previous = validateHistory(storedHistory); } catch { /* A valid new API result can replace an invalid fallback. */ }
  const status = { attemptedAt: clock().toISOString(), success: false,
    lastSuccessAt: isTimestamp(oldStatus?.lastSuccessAt) ? oldStatus.lastSuccessAt : null,
    snapshotFetchedAt: previous?.fetchedAt ?? null, sourceUrl: HISTORY_SOURCE,
    dataChanged: null, latestObservationDate: latestHistoryDate(previous) };
  try {
    const records = await fetchRecords(fetchImpl, onProgress);
    const history = aggregateHistory(records, clock().toISOString(), previous);
    if (previous && Date.parse(history.fetchedAt) < Date.parse(previous.fetchedAt)) fail('Nie można zastąpić historii kopią z wcześniejszym czasem pobrania.');
    await writeAtomically(historyPath, history);
    status.success = true;
    status.lastSuccessAt = history.fetchedAt;
    status.snapshotFetchedAt = history.fetchedAt;
    status.recordCount = records.length;
    status.itemCount = Object.keys(history.items).length;
    // Ignore the local download time when deciding whether the observations changed.
    status.dataChanged = !previous || !isDeepStrictEqual(
      JSON.parse(JSON.stringify(previous.items)), JSON.parse(JSON.stringify(history.items)));
    status.latestObservationDate = latestHistoryDate(history);
  } catch (error) {
    status.error = error instanceof HistoryError ? error.message : 'Nie udało się odświeżyć historii cen. Dostępna kopia pozostaje bez zmian.';
  }
  await writeAtomically(statusPath, status);
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Retain historical validation without refreshing a discontinued feed.
  console.error('Źródło zakończyło aktualizacje 24.10.2026. Nie pobrano historii. Użyj npm run sync:history, aby zapisać status archiwum.');
  process.exitCode = 1;
}
