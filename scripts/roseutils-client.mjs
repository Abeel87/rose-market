/**
 * Read-only connection diagnostic. This is not a market importer.
 * No provider response or credential is returned to the caller or written to disk.
 */
export const ROSEUTILS_ORIGIN = 'https://roseutils.com';
export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const SAMPLE_SIZE = 100;

const ENDPOINTS = Object.freeze({
  dates: `${ROSEUTILS_ORIGIN}/api/market/available-dates`,
  prices: `${ROSEUTILS_ORIGIN}/api/market/prices?per_page=${SAMPLE_SIZE}`,
});

const MESSAGES = Object.freeze({
  TOKEN_MISSING: 'Brak ROSEUTILS_API_TOKEN. Nie wykonano żadnego żądania HTTP.',
  TOKEN_INVALID: 'ROSEUTILS_API_TOKEN ma niepoprawny format. Nie wykonano żadnego żądania HTTP.',
  UNAUTHORIZED: 'ROSE Utils odrzucił uwierzytelnienie (HTTP 401). Sprawdź własny dostęp do API.',
  FORBIDDEN: 'ROSE Utils odmówił dostępu (HTTP 403). Wymagany jest dostęp przyznany temu projektowi.',
  RATE_LIMITED: 'ROSE Utils ograniczył liczbę żądań (HTTP 429). Nie wykonano ponowienia.',
  REDIRECT_REJECTED: 'Odrzucono przekierowanie. Token nie jest przekazywany pod inny adres.',
  HTTP_ERROR: 'ROSE Utils zwrócił nieudaną odpowiedź HTTP. Treść odpowiedzi pominięto.',
  RESPONSE_TOO_LARGE: 'Odpowiedź przekroczyła limit 8 MiB.',
  RESPONSE_EMPTY: 'ROSE Utils zwrócił pustą odpowiedź.',
  JSON_INVALID: 'Odpowiedź nie jest poprawnym dokumentem JSON w UTF-8.',
  SCHEMA_UNEXPECTED: 'Nierozpoznany format odpowiedzi. Schemat wymaga sprawdzenia przed integracją.',
  SAMPLE_LIMIT_EXCEEDED: 'Źródło nie zachowało limitu małej próbki diagnostycznej.',
  EMPTY_SAMPLE: 'Odpowiedź nie zawiera próbek cen. Nie potwierdzono dostępu do danych rynku.',
  REQUEST_TIMEOUT: 'Przekroczono limit 20 sekund na żądanie.',
  NETWORK_ERROR: 'Nie udało się odczytać odpowiedzi ROSE Utils. Szczegóły błędu sieci pominięto.',
  CHECK_FAILED: 'Nie udało się zakończyć diagnostyki. Szczegóły błędu pominięto.',
});

class DiagnosticError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.CHECK_FAILED);
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'CHECK_FAILED';
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function instant(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !day(match[1]) || +match[2] >= 24 || +match[3] >= 60 || +match[4] >= 60) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function number(value, integer = false) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER && (!integer || Number.isSafeInteger(n));
}

function summarizeDates(payload) {
  // These are explicit diagnostic shapes, not an inferred provider contract.
  // A different schema fails closed and requires review; dates are never invented.
  const keys = record(payload) ? ['dates', 'available_dates', 'data'].filter(key => Object.hasOwn(payload, key)) : [];
  const values = Array.isArray(payload) ? payload : keys.length === 1 ? payload[keys[0]] : null;
  if (!Array.isArray(values) || values.length > 10_000 || values.some(value => !day(value))) {
    throw new DiagnosticError('SCHEMA_UNEXPECTED');
  }
  const dates = [...new Set(values)].sort();
  return {
    shape: Array.isArray(payload) ? 'array' : `object.${keys[0]}`,
    count: values.length,
    distinctCount: dates.length,
    earliestDate: dates[0] || null,
    latestDate: dates.at(-1) || null,
  };
}

const PRICE_FIELDS = Object.freeze([
  'item_type', 'item_id', 'item_name', 'min_price', 'max_price', 'avg_price',
  'min_change_pct', 'latest_quantity', 'sample_count', 'last_updated', 'is_selling',
  'min_price_x', 'min_price_y', 'vendor_name', 'character_name', 'shop_name',
]);

function summarizePrices(payload) {
  if (!record(payload) || !Array.isArray(payload.data)) throw new DiagnosticError('SCHEMA_UNEXPECTED');
  const rows = payload.data;
  if (rows.length > SAMPLE_SIZE) throw new DiagnosticError('SAMPLE_LIMIT_EXCEEDED');
  if (!rows.length) throw new DiagnosticError('EMPTY_SAMPLE');
  const fields = new Set();
  const observations = [];
  let sellRows = 0;
  let buyRows = 0;
  let missingOrInvalidTimestampRows = 0;
  let unrecognizedFieldOccurrences = 0;
  for (const row of rows) {
    if (!record(row) || !number(row.item_type, true) || !number(row.item_id, true)
      || typeof row.item_name !== 'string' || !row.item_name.trim() || row.item_name.length > 200
      || !number(row.min_price) || ![true, false, 0, 1, '0', '1'].includes(row.is_selling)) {
      throw new DiagnosticError('SCHEMA_UNEXPECTED');
    }
    // Only fixed allowlisted field names are surfaced. Unknown JSON keys may
    // themselves contain sensitive values, so never print them.
    for (const key of Object.keys(row)) {
      if (PRICE_FIELDS.includes(key)) fields.add(key);
      else unrecognizedFieldOccurrences += 1;
    }
    if ([true, 1, '1'].includes(row.is_selling)) sellRows += 1;
    else buyRows += 1;
    const observedAt = instant(row.last_updated);
    if (observedAt) observations.push(observedAt);
    else missingOrInvalidTimestampRows += 1;
  }
  observations.sort();
  return {
    sampleCount: rows.length,
    requestedSampleLimit: SAMPLE_SIZE,
    isCompleteMarket: false,
    fields: PRICE_FIELDS.filter(key => fields.has(key)),
    unrecognizedFieldOccurrences,
    sellRows,
    buyRows,
    validTimestampRows: observations.length,
    missingOrInvalidTimestampRows,
    earliestSampleObservationAt: observations[0] || null,
    latestSampleObservationAt: observations.at(-1) || null,
  };
}

async function cancelBody(response) {
  try { await response?.body?.cancel(); } catch { /* Never echo cancellation errors. */ }
}

async function requestJson(endpoint, token, fetchImpl) {
  const url = ENDPOINTS[endpoint];
  if (!url || new URL(url).origin !== ROSEUTILS_ORIGIN) throw new DiagnosticError('CHECK_FAILED');
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new DiagnosticError('REQUEST_TIMEOUT'));
    }, REQUEST_TIMEOUT_MS);
  });
  const read = async () => {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'ROSE-Market-Connection-Check (+https://github.com/Abeel87/rose-market)',
      },
    });
    if (response.redirected || (response.url && response.url !== url)
      || (response.status >= 300 && response.status < 400)) {
      await cancelBody(response);
      throw new DiagnosticError('REDIRECT_REJECTED');
    }
    if (!response.ok) {
      await cancelBody(response);
      throw new DiagnosticError({ 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 429: 'RATE_LIMITED' }[response.status] || 'HTTP_ERROR');
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      await cancelBody(response);
      throw new DiagnosticError('RESPONSE_TOO_LARGE');
    }
    if (!response.body) throw new DiagnosticError('RESPONSE_EMPTY');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch { /* Fixed diagnostic below. */ }
          throw new DiagnosticError('RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!size) throw new DiagnosticError('RESPONSE_EMPTY');
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new DiagnosticError('JSON_INVALID');
    }
  };
  try {
    return await Promise.race([read(), deadline]);
  } catch (error) {
    // The original error can contain URLs, headers, token or response body.
    // Never retain it as a message, cause, stack, or diagnostic property.
    if (controller.signal.aborted) throw new DiagnosticError('REQUEST_TIMEOUT');
    throw new DiagnosticError(error instanceof DiagnosticError ? error.code : 'NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

/** At most two GETs; no retries, pagination, import, disk writes or other origins. */
export async function checkRoseutilsConnection({ fetchImpl = globalThis.fetch } = {}) {
  const result = {
    mode: 'connection_check',
    imported: false,
    source: ROSEUTILS_ORIGIN,
    success: false,
    freshnessConfirmed: false,
    requestsAttempted: 0,
    notice: 'To wyłącznie sprawdzenie połączenia i schematu małej próbki, nie import ani potwierdzenie aktualności całego rynku.',
  };
  const token = process.env.ROSEUTILS_API_TOKEN;
  try {
    if (typeof token !== 'string' || !token.trim()) throw new DiagnosticError('TOKEN_MISSING');
    // Bearer credentials must not contain whitespace, controls or injected headers.
    if (token.length > 4096 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw new DiagnosticError('TOKEN_INVALID');
    result.requestsAttempted += 1;
    result.availableDates = summarizeDates(await requestJson('dates', token, fetchImpl));
    result.requestsAttempted += 1;
    result.prices = summarizePrices(await requestJson('prices', token, fetchImpl));
    result.success = true;
    result.code = 'CONNECTION_CHECK_OK';
  } catch (error) {
    const code = error instanceof DiagnosticError ? error.code : 'CHECK_FAILED';
    result.code = code;
    result.message = MESSAGES[code];
  }
  return result;
}
