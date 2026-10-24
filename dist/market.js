/**
 * ROSE Market data utilities. A snapshot records the last observation; it is
 * not a live inventory, and an offer price does not imply a per-unit price.
 */

const ICON_ORIGIN = 'https://roseonlinetoolbox.com';
const SUPPORTED_MAP_ID = 'city_of_junon_polis';

function fail(path, message) {
  throw new TypeError(`${path}: ${message}`);
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  return value;
}

function tuple(value, length, path) {
  if (!Array.isArray(value) || value.length !== length) fail(path, `expected an array of ${length} entries`);
  return value;
}

function label(value, path) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(path, 'expected a nonempty text label without control characters');
  }
  return value;
}

function isoDate(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(path, 'expected an ISO calendar date');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) fail(path, 'invalid calendar date');
  return value;
}

function timestamp(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    fail(path, 'expected an ISO UTC timestamp');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) fail(path, 'invalid timestamp');
  return date.toISOString();
}

function sourceUrl(value, path) {
  if (typeof value !== 'string') fail(path, 'expected an HTTPS source URL');
  let url;
  try { url = new URL(value); } catch { fail(path, 'invalid source URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail(path, 'source must use HTTPS without credentials');
  return url.href;
}

function iconUrl(value, path) {
  // The public snapshot explicitly uses null when no source icon is known.
  if (value === null) return null;
  if (typeof value !== 'string' || !value.startsWith('/Icons/ru/') || value.includes('\\') || /[\u0000-\u0020\u007f?#]/.test(value)) {
    fail(path, 'expected a safe /Icons/ru/ asset path');
  }
  let url;
  try { url = new URL(value, ICON_ORIGIN); } catch { fail(path, 'invalid icon path'); }
  if (url.origin !== ICON_ORIGIN || !url.pathname.startsWith('/Icons/ru/')) fail(path, 'icon path leaves the asset directory');
  return url.href;
}

function coordinate(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite numeric coordinate');
  return Object.is(value, -0) ? 0 : value;
}

/** Project Junon Polis world coordinates to its calibrated 576 × 512 map. */
export function worldToMap(x, y) {
  x = coordinate(x, 'x');
  y = coordinate(y, 'y');
  const px = (x - 4674.89) * 0.4156;
  const py = (y - 5741.2) * -0.4156;
  // Allow only floating-point rounding at the exact image edges.
  const epsilon = 1e-9;
  if (px < -epsilon || px > 576 + epsilon || py < -epsilon || py > 512 + epsilon) {
    fail('coordinates', 'position is outside the calibrated Junon Polis map');
  }
  return { px: Math.max(0, Math.min(576, px)), py: Math.max(0, Math.min(512, py)) };
}

function fold(value) {
  return String(value).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[łŁ]/g, 'l').toLocaleLowerCase('pl');
}

function slug(value) {
  return fold(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'entry';
}

// A deterministic identity hash, not a security primitive. Including the
// original canonical text keeps different accented names distinct as IDs.
function hash(value) {
  let result = 14695981039346656037n;
  for (let i = 0; i < value.length; i++) {
    result ^= BigInt(value.charCodeAt(i));
    result = BigInt.asUintN(64, result * 1099511628211n);
  }
  return result.toString(36);
}

function canonical(value) {
  return value.trim().normalize('NFC').toLowerCase();
}

function later(a, b) {
  return a === null || b > a ? b : a;
}

/**
 * Convert the compact provider snapshot into explicit objects. Invalid input
 * throws TypeError with a data path; records are never silently discarded.
 * HTML-looking player/item names remain inert strings for the UI to escape.
 * Asset hosting is independent of meta.source attribution.
 *
 * @returns {{meta: object, items: Array, stalls: Array, offers: Array, stats: object}}
 */
export function normalizeSnapshot(raw) {
  object(raw, 'snapshot');
  const suppliedMeta = object(raw._meta, '_meta');
  const mapId = label(suppliedMeta.mapId, '_meta.mapId');
  if (!/^[a-zA-Z0-9_-]+$/.test(mapId)) fail('_meta.mapId', 'expected a map identifier');
  if (mapId !== SUPPORTED_MAP_ID) fail('_meta.mapId', `unsupported map; calibration is available only for ${SUPPORTED_MAP_ID}`);
  const meta = {
    source: sourceUrl(suppliedMeta.source, '_meta.source'),
    date: isoDate(suppliedMeta.date, '_meta.date'),
    fetchedAt: timestamp(suppliedMeta.fetchedAt, '_meta.fetchedAt'),
    mapId,
  };
  if (!Array.isArray(raw.items)) fail('items', 'expected an array');
  if (!Array.isArray(raw.stalls)) fail('stalls', 'expected an array');

  const itemIds = new Set();
  const items = raw.items.map((entry, index) => {
    tuple(entry, 2, `items[${index}]`);
    const name = label(entry[0], `items[${index}][0]`);
    const id = `item-${slug(name)}-${hash(canonical(name))}`;
    if (itemIds.has(id)) fail(`items[${index}][0]`, 'duplicate item identity');
    itemIds.add(id);
    return { id, name, icon: iconUrl(entry[1], `items[${index}][1]`) };
  });

  const stallIds = new Set();
  const offers = [];
  let sellOffers = 0;
  let buyOffers = 0;
  let lastSeenAt = null;
  const stalls = raw.stalls.map((entry, index) => {
    const path = `stalls[${index}]`;
    tuple(entry, 5, path);
    const player = label(entry[0], `${path}[0]`);
    const x = coordinate(entry[1], `${path}[1]`);
    const y = coordinate(entry[2], `${path}[2]`);
    try { worldToMap(x, y); } catch (error) { fail(path, error.message); }
    const seenAt = timestamp(entry[3], `${path}[3]`);
    if (!Array.isArray(entry[4])) fail(`${path}[4]`, 'expected an array of offers');
    const id = `stall-${slug(player)}-${hash(JSON.stringify([canonical(player), x, y]))}`;
    if (stallIds.has(id)) fail(path, 'duplicate stall identity');
    stallIds.add(id);
    lastSeenAt = later(lastSeenAt, seenAt);
    const duplicateOffers = new Map();
    const stallOffers = entry[4].map((listing, offerIndex) => {
      const offerPath = `${path}[4][${offerIndex}]`;
      tuple(listing, 4, offerPath);
      const [itemIndex, price, buyingFlag, bestFlag] = listing;
      if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= items.length) fail(`${offerPath}[0]`, 'unknown item index');
      if (!Number.isSafeInteger(price) || price < 0) fail(`${offerPath}[1]`, 'expected a nonnegative safe integer price');
      if (buyingFlag !== 0 && buyingFlag !== 1) fail(`${offerPath}[2]`, 'buying flag must be 0 or 1');
      if (bestFlag !== 0 && bestFlag !== 1) fail(`${offerPath}[3]`, 'best flag must be 0 or 1');
      const item = items[itemIndex];
      const type = buyingFlag === 1 ? 'buy' : 'sell';
      const base = `offer-${hash(JSON.stringify([id, item.id, type, price]))}`;
      const occurrence = (duplicateOffers.get(base) || 0) + 1;
      duplicateOffers.set(base, occurrence);
      const offer = {
        id: `${base}-${occurrence}`,
        itemId: item.id,
        itemName: item.name,
        icon: item.icon,
        player,
        stallId: id,
        x, y, seenAt, type, price,
      };
      // Provider bestFlag is deliberately not used for price comparisons.
      if (type === 'buy') buyOffers++; else sellOffers++;
      offers.push(offer);
      return offer;
    });
    return { id, player, x, y, seenAt, offers: stallOffers };
  });

  return {
    meta, items, stalls, offers,
    stats: { items: items.length, stalls: stalls.length, offers: offers.length, sellOffers, buyOffers, lastSeenAt },
  };
}

const compareText = (a, b) => String(a).localeCompare(String(b), 'pl', { sensitivity: 'base', numeric: true });
const byIdentity = (a, b) => compareText(a.itemName, b.itemName) || compareText(a.player, b.player) || a.id.localeCompare(b.id);

/**
 * Search by item name OR vendor name, optionally filter favorites, and sort.
 * type accepts sell, buy, or all. A fresh array is returned; input is unchanged.
 */
export function filterOffers(offers, { query = '', type = 'sell', favorites = [], onlyFavorites = false, sort = 'price-asc' } = {}) {
  if (!Array.isArray(offers)) fail('offers', 'expected normalized offers');
  if (!['sell', 'buy', 'all'].includes(type)) fail('type', 'expected sell, buy, or all');
  if (!['price-asc', 'price-desc', 'name', 'recent'].includes(sort)) fail('sort', 'unknown offer sort');
  const q = fold(query ?? '').trim();
  const favoriteIds = favorites instanceof Set ? favorites : new Set(Array.isArray(favorites) ? favorites : []);
  const result = offers.filter(offer =>
    (type === 'all' || offer.type === type) &&
    (!onlyFavorites || favoriteIds.has(offer.itemId)) &&
    (!q || fold(offer.itemName).includes(q) || fold(offer.player).includes(q))
  );
  const comparators = {
    'price-asc': (a, b) => a.price - b.price || byIdentity(a, b),
    'price-desc': (a, b) => b.price - a.price || byIdentity(a, b),
    name: (a, b) => compareText(a.itemName, b.itemName) || a.price - b.price || byIdentity(a, b),
    recent: (a, b) => b.seenAt.localeCompare(a.seenAt) || a.price - b.price || byIdentity(a, b),
  };
  return result.sort(comparators[sort]);
}

/** Group offers by item; recompute lowest sell and highest buy from prices. */
export function getItemSummary(offers) {
  if (!Array.isArray(offers)) fail('offers', 'expected normalized offers');
  const groups = new Map();
  for (const offer of offers) {
    let group = groups.get(offer.itemId);
    if (!group) {
      group = {
        itemId: offer.itemId, itemName: offer.itemName, icon: offer.icon,
        offerCount: 0, sellCount: 0, buyCount: 0, lowestSell: null, highestBuy: null,
        lastSeenAt: null, sellers: new Set(), buyers: new Set(),
      };
      groups.set(offer.itemId, group);
    }
    group.offerCount++;
    group.lastSeenAt = later(group.lastSeenAt, offer.seenAt);
    if (offer.type === 'sell') {
      group.sellCount++;
      group.sellers.add(offer.player);
      group.lowestSell = group.lowestSell === null ? offer.price : Math.min(group.lowestSell, offer.price);
    } else if (offer.type === 'buy') {
      group.buyCount++;
      group.buyers.add(offer.player);
      group.highestBuy = group.highestBuy === null ? offer.price : Math.max(group.highestBuy, offer.price);
    }
  }
  return [...groups.values()].map(({ sellers, buyers, ...group }) => ({
    ...group, sellerCount: sellers.size, buyerCount: buyers.size,
  })).sort((a, b) => compareText(a.itemName, b.itemName) || a.itemId.localeCompare(b.itemId));
}
