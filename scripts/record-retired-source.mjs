import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validatePair } from './published-data.mjs';
import { normalizeSnapshot } from '../dist/market.js';
import { latestHistoryDate } from './sync-history.mjs';

const DATA_DIRECTORY = fileURLToPath(new URL('../dist/data/', import.meta.url));
export const RETIREMENT_DATE = '2026-10-24';
export const RETIREMENT_NOTICE = 'https://roseonlinetoolbox.com/market';
export const RETIREMENT_MESSAGE = 'ROSE Online Toolbox zakończył aktualizowanie cen 24.10.2026. Pokazujemy zachowane archiwum. Przywrócenie aktualnych danych wymaga dostępu do nowego źródła.';

/**
 * The provider explicitly discontinued updates. Do not keep downloading its
 * frozen snapshot or turn a new HTTP timestamp into a successful refresh.
 * Only status is changed: observations, prices and last successful fetch stay
 * exactly as they were in the last validated deployment.
 */
export async function recordRetiredSource(kind, {
  dataDirectory = DATA_DIRECTORY,
  clock = () => new Date(),
} = {}) {
  const files = kind === 'market' ? ['market-stalls.json', 'sync-status.json']
    : kind === 'history' ? ['price-history.json', 'history-status.json'] : null;
  if (!files) throw new Error('Wybierz źródło: market albo history.');
  const [data, previous] = await Promise.all(files.map(file =>
    readFile(join(dataDirectory, file), 'utf8').then(JSON.parse)));
  const validated = validatePair(data, previous, kind);
  const attemptedAt = clock().toISOString();
  if (Date.parse(attemptedAt) < Date.parse(previous.attemptedAt)) {
    throw new Error('Nie można cofnąć czasu kontroli źródła.');
  }
  const status = {
    ...previous,
    attemptedAt,
    success: false,
    dataChanged: null,
    reason: 'source_retired',
    sourceRetiredAt: RETIREMENT_DATE,
    sourceNoticeUrl: RETIREMENT_NOTICE,
    alternativeSourceUrl: 'https://roseutils.com/',
    snapshotFetchedAt: validated.fetchedAt,
    error: RETIREMENT_MESSAGE,
    ...(kind === 'market'
      ? { latestObservationAt: normalizeSnapshot(data).stats.lastSeenAt }
      : { latestObservationDate: latestHistoryDate(data) }),
  };
  const target = join(dataDirectory, files[1]);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(status)}\n`, { flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await recordRetiredSource(process.argv[2]);
    console.error(RETIREMENT_MESSAGE);
    // Pages is still allowed to publish the verified archive and this status.
    // The refresh itself must never be marked successful.
    process.exitCode = 1;
  } catch {
    console.error('Nie udało się zweryfikować archiwum i zapisać statusu zakończonego źródła.');
    process.exitCode = 1;
  }
}
