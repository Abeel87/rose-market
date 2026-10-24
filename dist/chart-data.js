/** Real observed daily ranges for an item; no interpolation or synthetic days. */

const DAY_MS = 86_400_000;
const RANGE_DAYS = new Set([7, 30, 90]);
const PRICE_FIELDS = ['sellMin', 'sellMax', 'buyMin', 'buyMax'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPrice = value => Number.isSafeInteger(value) && value >= 0;

/** Match full names without discarding accents or guessing source item IDs. */
export function canonicalItemName(name) {
  return typeof name === 'string' ? name.normalize('NFC').trim().toLowerCase() : '';
}

function emptyResult() {
  return {
    points: [], hasImportedHistory: false, currentOnly: false,
    observationDays: 0, firstDate: null, lastDate: null,
  };
}

function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms;
}

function observedAt(value) {
  // normalizeSnapshot emits UTC timestamps. Reject loose date parsing and
  // rolled-over dates such as February 30 or the following day's 24:00.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return ms;
}

function validPair(min, max) {
  return (min === null && max === null) || (isPrice(min) && isPrice(max) && min <= max);
}

function validImportedPoint(point) {
  if (!isObject(point) || !Object.hasOwn(point, 'date')) return false;
  if (!PRICE_FIELDS.every(field => Object.hasOwn(point, field))) return false;
  if (!validPair(point.sellMin, point.sellMax) || !validPair(point.buyMin, point.buyMax)) return false;
  return point.sellMin !== null || point.buyMin !== null;
}

/**
 * Combine imported reports and normalized current offers by actual UTC day.
 * Invalid imported points and malformed offers are ignored independently.
 * A side without observations keeps both limits null; counts are not merged.
 *
 * days accepts 7, 30 or 90 (other values use 30). The inclusive window ends on
 * now's UTC day. Current offers later than the exact now timestamp are ignored.
 * now is an epoch-millisecond number; an invalid clock returns an empty result.
 *
 * Flags describe the selected window, not the item's entire stored history.
 * currentOnly is true only for nonempty results with no imported observations.
 *
 * @returns {{points: Array<{date: string, sellMin: number|null, sellMax: number|null,
 * buyMin: number|null, buyMax: number|null, sources: Array<'history'|'current'>}>,
 * hasImportedHistory: boolean, currentOnly: boolean, observationDays: number,
 * firstDate: string|null, lastDate: string|null}}
 */
export function buildItemHistory(historyDataset, itemName, currentOffers, { days = 30, now = Date.now() } = {}) {
  const key = canonicalItemName(itemName);
  if (!key || typeof now !== 'number' || !Number.isFinite(now)) return emptyResult();
  const today = new Date(now);
  if (!Number.isFinite(today.valueOf())) return emptyResult();
  today.setUTCHours(0, 0, 0, 0);
  const lastDay = today.valueOf();
  const firstDay = lastDay - ((RANGE_DAYS.has(days) ? days : 30) - 1) * DAY_MS;
  const inWindow = ms => ms !== null && ms >= firstDay && ms <= lastDay;
  const byDay = new Map();

  function merge(date, ranges, source) {
    let point = byDay.get(date);
    if (!point) {
      point = { date, sellMin: null, sellMax: null, buyMin: null, buyMax: null, sources: [] };
      byDay.set(date, point);
    }
    for (const type of ['sell', 'buy']) {
      const min = `${type}Min`;
      const max = `${type}Max`;
      if (ranges[min] === null) continue;
      point[min] = point[min] === null ? ranges[min] : Math.min(point[min], ranges[min]);
      point[max] = point[max] === null ? ranges[max] : Math.max(point[max], ranges[max]);
    }
    if (!point.sources.includes(source)) point.sources.push(source);
  }

  // A source name such as __proto__ must never retrieve an inherited property.
  const items = isObject(historyDataset) && historyDataset.version === 1 ? historyDataset.items : null;
  const imported = isObject(items) && Object.hasOwn(items, key) ? items[key] : null;
  if (isObject(imported) && canonicalItemName(imported.name) === key && Array.isArray(imported.points)) {
    for (const point of imported.points) {
      if (!validImportedPoint(point) || !inWindow(calendarDay(point.date))) continue;
      merge(point.date, point, 'history');
    }
  }

  if (Array.isArray(currentOffers)) {
    for (const offer of currentOffers) {
      if (!isObject(offer) || canonicalItemName(offer.itemName) !== key || !isPrice(offer.price)) continue;
      if (offer.type !== 'sell' && offer.type !== 'buy') continue;
      const ms = observedAt(offer.seenAt);
      if (ms === null || ms > now) continue;
      const date = offer.seenAt.slice(0, 10);
      if (!inWindow(calendarDay(date))) continue;
      const ranges = { sellMin: null, sellMax: null, buyMin: null, buyMax: null };
      ranges[`${offer.type}Min`] = offer.price;
      ranges[`${offer.type}Max`] = offer.price;
      merge(date, ranges, 'current');
    }
  }

  const points = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const hasImportedHistory = points.some(point => point.sources.includes('history'));
  return {
    points,
    hasImportedHistory,
    currentOnly: points.length > 0 && !hasImportedHistory,
    observationDays: points.length,
    firstDate: points[0]?.date ?? null,
    lastDate: points.at(-1)?.date ?? null,
  };
}
