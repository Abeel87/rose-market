import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeSnapshot, filterOffers, getItemSummary, worldToMap } from '../dist/market.js';

const fixture = () => ({
  _meta: { source: 'https://roseutils.com/market', date: '2026-10-24', fetchedAt: '2026-10-24T08:00:51.920Z', mapId: 'city_of_junon_polis' },
  items: [['Ruby [7]', '/Icons/ru/gem/ruby_7.png'], ['Żółty Gem', '/Icons/ru/gem/yellow.png']],
  stalls: [
    ['Łukasz', 5600.25, 5300, '2026-10-24T06:17:11.000Z', [[0, 100, 0, 1], [0, 70, 1, 0], [1, 50, 0, 0]]],
    ['Artisan', 5610, 5310.5, '2026-10-24T06:19:00Z', [[0, 90, 0, 0], [0, 80, 1, 0]]],
  ],
});

test('normalizes known sample without treating attribution as the icon host', () => {
  const raw = fixture();
  const original = structuredClone(raw);
  const data = normalizeSnapshot(raw);
  assert.deepEqual(data.stats, { items: 2, stalls: 2, offers: 5, sellOffers: 3, buyOffers: 2, lastSeenAt: '2026-10-24T06:19:00.000Z' });
  assert.equal(data.meta.source, 'https://roseutils.com/market');
  assert.equal(data.meta.fetchedAt, raw._meta.fetchedAt);
  assert.equal(data.items[0].icon, 'https://roseonlinetoolbox.com/Icons/ru/gem/ruby_7.png');
  assert.equal(data.offers[0].player, 'Łukasz');
  assert.equal(data.offers[0].x, 5600.25);
  assert.equal(data.offers[0].seenAt, raw.stalls[0][3]);
  assert.equal(data.stalls[0].offers[0].id, data.offers[0].id);
  assert.deepEqual(raw, original);
});

test('buy and sell remain distinct; summaries ignore misleading provider best flags', () => {
  const data = normalizeSnapshot(fixture());
  assert.equal(data.offers[0].type, 'sell');
  assert.equal(data.offers[1].type, 'buy');
  const ruby = getItemSummary(data.offers).find(item => item.itemName === 'Ruby [7]');
  assert.deepEqual({ count: ruby.offerCount, sell: ruby.sellCount, buy: ruby.buyCount, low: ruby.lowestSell, high: ruby.highestBuy }, { count: 4, sell: 2, buy: 2, low: 90, high: 80 });
  assert.equal(ruby.sellerCount, 2);
  assert.equal(ruby.buyerCount, 2);
  assert.equal(getItemSummary(data.offers).find(item => item.itemName === 'Żółty Gem').highestBuy, null);
});

test('does not invent quantities, a per-unit basis, availability, or a live timestamp', () => {
  const { offers, meta } = normalizeSnapshot(fixture());
  for (const offer of offers) {
    assert.deepEqual(Object.keys(offer).sort(), ['id', 'itemId', 'itemName', 'icon', 'player', 'stallId', 'x', 'y', 'seenAt', 'type', 'price'].sort());
  }
  assert.equal(meta.date, '2026-10-24');
  assert.equal(offers[0].price, 100);
});

test('explicitly missing provider icons remain null for a neutral UI fallback', () => {
  const raw = fixture(); raw.items[0][1] = null;
  const data = normalizeSnapshot(raw);
  assert.equal(data.items[0].icon, null);
  assert.equal(data.offers[0].icon, null);
});

test('names that look like HTML or prototype keys stay inert data', () => {
  const raw = fixture();
  raw.items[0][0] = '<img src=x onerror="throw 1">';
  raw.stalls[0][0] = '__proto__';
  const data = normalizeSnapshot(raw);
  assert.equal(data.offers[0].itemName, raw.items[0][0]);
  assert.equal(data.offers[0].player, '__proto__');
  assert.match(data.offers[0].itemId, /^[a-z0-9-]+$/);
  assert.equal(filterOffers(data.offers, { query: '__proto__' }).length, 2);
});

test('unsafe icon schemes, traversal and source URLs fail with a useful path', () => {
  for (const icon of ['javascript:alert(1)', '//evil.example/icon.png', '/Icons/ru/../../../secret.png', '/Icons/ru/\\evil.png']) {
    const raw = fixture(); raw.items[0][1] = icon;
    assert.throws(() => normalizeSnapshot(raw), /items\[0\]\[1\]/);
  }
  const raw = fixture(); raw._meta.source = 'javascript:alert(1)';
  assert.throws(() => normalizeSnapshot(raw), /_meta.source/);
});

test('malformed schemas, dates, coordinates, prices and item references fail rather than disappearing', () => {
  const corruptions = [
    [r => { r.items[0].push('extra'); }, /items\[0\]/],
    [r => { r._meta.date = '2026-02-30'; }, /_meta.date/],
    [r => { r.stalls[0][3] = '2026-02-30T01:02:03Z'; }, /stalls\[0\]\[3\]/],
    [r => { r.stalls[0][3] = '2026-10-24T24:00:00Z'; }, /stalls\[0\]\[3\]/],
    [r => { r.stalls[0][1] = Infinity; }, /stalls\[0\]\[1\]/],
    [r => { r.stalls[0][2] = '5300'; }, /stalls\[0\]\[2\]/],
    [r => { r.stalls[0][4][0][1] = -1; }, /\[1\]/],
    [r => { r.stalls[0][4][0][1] = Number.MAX_SAFE_INTEGER + 1; }, /\[1\]/],
    [r => { r.stalls[0][4][0][0] = 99; }, /\[0\]/],
    [r => { r.stalls[0][4][0][2] = true; }, /\[2\]/],
    [r => { r.stalls[0][4][0].push(50); }, /expected an array of 4/],
  ];
  for (const [corrupt, expected] of corruptions) {
    const raw = fixture(); corrupt(raw);
    assert.throws(() => normalizeSnapshot(raw), expected);
  }
});

test('item, stall and offer identities survive item/stall/offer reordering and later observations', () => {
  const raw = fixture();
  const baseline = normalizeSnapshot(raw);
  const next = fixture();
  next.items.reverse();
  next.stalls.reverse();
  for (const stall of next.stalls) {
    stall[3] = '2026-10-24T07:00:00.000Z';
    stall[4].reverse();
    for (const listing of stall[4]) listing[0] = 1 - listing[0];
  }
  const updated = normalizeSnapshot(next);
  assert.deepEqual(updated.items.map(i => i.id).sort(), baseline.items.map(i => i.id).sort());
  assert.deepEqual(updated.stalls.map(i => i.id).sort(), baseline.stalls.map(i => i.id).sort());
  assert.deepEqual(updated.offers.map(i => i.id).sort(), baseline.offers.map(i => i.id).sort());
});

test('identical listings remain separate observed offers with unique IDs, not inferred stock', () => {
  const raw = fixture();
  raw.stalls[0][4].push([...raw.stalls[0][4][0]]);
  const data = normalizeSnapshot(raw);
  assert.equal(data.offers.length, 6);
  assert.equal(new Set(data.offers.map(i => i.id)).size, 6);
  assert.ok(!('quantity' in data.offers[0]));
});

test('filtering searches item OR player without Polish diacritic barriers', () => {
  const data = normalizeSnapshot(fixture());
  assert.equal(filterOffers(data.offers, { query: 'zolty' }).length, 1);
  assert.equal(filterOffers(data.offers, { query: 'LUKASZ', type: 'all' }).length, 3);
  assert.equal(filterOffers(data.offers, { query: 'ruby', type: 'buy' }).length, 2);
  assert.equal(filterOffers(data.offers).length, 3);
});

test('favorites work with both Set and array, and sorting never mutates the input', () => {
  const data = normalizeSnapshot(fixture());
  const before = data.offers.map(offer => offer.id);
  const favorite = data.items[0].id;
  for (const favorites of [new Set([favorite]), [favorite]]) assert.equal(filterOffers(data.offers, { onlyFavorites: true, favorites, type: 'all' }).length, 4);
  assert.deepEqual(filterOffers(data.offers).map(x => x.price), [50, 90, 100]);
  assert.deepEqual(filterOffers(data.offers, { sort: 'price-desc' }).map(x => x.price), [100, 90, 50]);
  assert.equal(filterOffers(data.offers, { sort: 'recent' })[0].player, 'Artisan');
  assert.equal(filterOffers(data.offers, { sort: 'name' })[0].itemName, 'Ruby [7]');
  assert.deepEqual(data.offers.map(offer => offer.id), before);
});

test('empty snapshots normalize to explicit zero counts and no observation date', () => {
  const raw = fixture(); raw.items = []; raw.stalls = [];
  const data = normalizeSnapshot(raw);
  assert.equal(data.stats.offers, 0);
  assert.equal(data.stats.lastSeenAt, null);
  assert.deepEqual(getItemSummary(data.offers), []);
});

test('Junon calibration maps GoldenBinangKal correctly and rejects unsupported map locations', () => {
  const position = worldToMap(5698.27, 5246.75);
  assert.ok(Math.abs(position.px - 425.316728) < 1e-9);
  assert.ok(Math.abs(position.py - 205.49342) < 1e-9);
  assert.deepEqual(worldToMap(4674.89, 5741.2), { px: 0, py: 0 });
  for (const [x, y] of [[4674.88, 5741.2], [6061, 5300], [5600, 5741.21], [5600, 4500]]) {
    assert.throws(() => worldToMap(x, y), /outside the calibrated/);
  }
  const otherMap = fixture(); otherMap._meta.mapId = 'zant';
  assert.throws(() => normalizeSnapshot(otherMap), /_meta.mapId: unsupported map/);
  const outside = fixture(); outside.stalls[0][1] = 0;
  assert.throws(() => normalizeSnapshot(outside), /stalls\[0\].*outside the calibrated/);
});

test('the checked-in provider snapshot passes the same strict normalization used by sync', async () => {
  const raw = JSON.parse(await readFile(new URL('../dist/data/market-stalls.json', import.meta.url), 'utf8'));
  const data = normalizeSnapshot(raw);
  assert.equal(data.items.length, raw.items.length);
  assert.equal(data.stalls.length, raw.stalls.length);
  assert.equal(data.offers.length, raw.stalls.reduce((sum, stall) => sum + stall[4].length, 0));
  assert.equal(data.stats.sellOffers + data.stats.buyOffers, data.offers.length);
});
