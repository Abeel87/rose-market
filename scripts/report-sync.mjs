import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { validatePair } from './published-data.mjs';
import { normalizeSnapshot } from '../dist/market.js';
import { latestHistoryDate } from './sync-history.mjs';

const DATA_DIRECTORY = fileURLToPath(new URL('../dist/data/', import.meta.url));

export function checkAttempt(status, outcome, startedAt) {
  if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(status.attemptedAt))
    || Date.parse(status.attemptedAt) < Date.parse(startedAt)
    || !['success', 'failure'].includes(outcome) || status.success !== (outcome === 'success')
    || (status.success ? typeof status.dataChanged !== 'boolean' : status.dataChanged !== null)) {
    throw new Error('Missing or inconsistent status for this refresh attempt; refusing to publish.');
  }
}

export async function reportSync({ dataDirectory = DATA_DIRECTORY, startedAt = process.env.REFRESH_STARTED_AT,
  marketOutcome = process.env.SYNC_OUTCOME, historyOutcome = process.env.HISTORY_OUTCOME } = {}) {
  const sections = [];
  let healthy = true;
  for (const [kind, name, file, statusFile, outcome] of [
    ['market', 'Rynek', 'market-stalls.json', 'sync-status.json', marketOutcome],
    ['history', 'Historia cen', 'price-history.json', 'history-status.json', historyOutcome],
  ]) {
    const [data, status] = await Promise.all([file, statusFile].map(name => readFile(join(dataDirectory, name), 'utf8').then(JSON.parse)));
    validatePair(data, status, kind);
    checkAttempt(status, outcome, startedAt);
    healthy &&= status.success;
    const observed = kind === 'market' ? normalizeSnapshot(data).stats.lastSeenAt : latestHistoryDate(data);
    const note = !status.success ? 'Błąd pobrania. Zachowano ostatnie poprawne dane.'
      : status.dataChanged ? 'Pobrano zmienione dane.' : 'Pobranie udane, ale dane źródłowe bez zmian.';
    sections.push(`## ${name}\n\n${note}\n\nPróba: ${status.attemptedAt}\n\nData pobrania kopii: ${status.snapshotFetchedAt}\n\nNajnowsza obserwacja (UTC): ${observed}\n`);
    if (!status.success) console.log(`::warning::${name}: ${status.error}`);
    if (Date.now() - Date.parse(observed) > 86_400_000) console.log(`::warning::${name}: obserwacje starsze niż 24 godziny (${observed}); udane pobranie nie oznacza nowych ofert.`);
  }
  return { healthy, summary: sections.join('\n') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await reportSync();
    console.log(result.summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, result.summary);
    if (process.argv.includes('--require-success') && !result.healthy) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
