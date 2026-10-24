import test from 'node:test';
import assert from 'node:assert/strict';
import { buildItemHistory, canonicalItemName } from '../dist/chart-data.js';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const point = (date, values = {}) => ({
  date, sellMin: 100, sellMax: 120, buyMin: null, buyMax: null,
  sellCount: 2, buyCount: 0, ...values,
});
const history = (points, name = 'Ruby [7]') => ({
  version: 1,
  items: { [canonicalItemName(name)]: { name, sourceItemId: 'ruby-7', points } },
});
const offer = (price, type = 'sell', seenAt = '2026-10-24T06:17:10.000Z', itemName = 'Ruby [7]') => ({
  price, type, seenAt, itemName,
});
const empty = {
  points: [], hasImportedHistory: false, currentOnly: false,
  observationDays: 0, firstDate: null, lastDate: null,
};

test('full-name matching uses NFC, whitespace and case without removing accents', () => {
  assert.equal(canonicalItemName('  ŻÓŁTY GE\u0301M  '), 'żółty gém');
  assert.notEqual(canonicalItemName('żółty gém'), canonicalItemName('zolty gem'));
  assert.equal(canonicalItemName(null), '');
  assert.equal(canonicalItemName({ toString: () => 'Ruby [7]' }), '');
  const result = buildItemHistory(history([point('2026-10-20')], 'Żółty Gém'), ' ŻÓŁTY GE\u0301M ', [
    offer(80, 'buy', '2026-10-24T06:00:00Z', 'żółty gém'),
    offer(1, 'sell', '2026-10-24T06:00:00Z', 'zolty gem'),
  ], { now: NOW });
  assert.equal(result.observationDays, 2);
  assert.deepEqual(result.points[1], {
    date: '2026-10-24', sellMin: null, sellMax: null, buyMin: 80, buyMax: 80, sources: ['current'],
  });
});

test('actual source days remain sparse and buy/sell ranges stay separate', () => {
  const result = buildItemHistory(history([
    point('2026-10-20', { buyMin: 60, buyMax: 70, buyCount: 5 }),
  ]), 'Ruby [7]', [offer(90), offer(75, 'buy'), offer(1000, 'sell', '2026-10-24T06:00:00Z', 'Emerald [7]')], { now: NOW });
  assert.deepEqual(result, {
    points: [
      { date: '2026-10-20', sellMin: 100, sellMax: 120, buyMin: 60, buyMax: 70, sources: ['history'] },
      { date: '2026-10-24', sellMin: 90, sellMax: 90, buyMin: 75, buyMax: 75, sources: ['current'] },
    ],
    hasImportedHistory: true, currentOnly: false, observationDays: 2,
    firstDate: '2026-10-20', lastDate: '2026-10-24',
  });
  assert.ok(result.points.every(p => !Object.hasOwn(p, 'sellCount') && !Object.hasOwn(p, 'buyCount')));
});

test('merges same-day ranges across sources without treating report counts as traders', () => {
  const result = buildItemHistory(history([
    point('2026-10-24', { sellMin: 100, sellMax: 200, buyMin: 40, buyMax: 70 }),
    point('2026-10-24', { sellMin: 90, sellMax: 180, buyMin: 50, buyMax: 80 }),
  ]), 'Ruby [7]', [offer(85), offer(220), offer(35, 'buy'), offer(95, 'buy')], { now: NOW });
  assert.deepEqual(result.points, [{
    date: '2026-10-24', sellMin: 85, sellMax: 220, buyMin: 35, buyMax: 95, sources: ['history', 'current'],
  }]);
  assert.equal(result.observationDays, 1);
  assert.equal(result.hasImportedHistory, true);
  assert.equal(result.currentOnly, false);
});

test('unknown items fall back to their real current observation, not today', () => {
  const result = buildItemHistory(history([point('2026-10-24')]), 'Other item', [
    offer(42, 'sell', '2026-10-20T23:59:59Z', 'Other item'),
    offer(1, 'sell', '2026-10-24T01:00:00Z'),
  ], { now: NOW });
  assert.deepEqual(result, {
    points: [{ date: '2026-10-20', sellMin: 42, sellMax: 42, buyMin: null, buyMax: null, sources: ['current'] }],
    hasImportedHistory: false, currentOnly: true, observationDays: 1,
    firstDate: '2026-10-20', lastDate: '2026-10-20',
  });
  assert.deepEqual(buildItemHistory(null, 'No observations', [], { now: NOW }), empty);
});

test('7/30/90-day ranges include their first UTC calendar day and exclude the previous day', () => {
  const candidates = ['2026-07-26', '2026-07-27', '2026-09-24', '2026-09-25', '2026-10-17', '2026-10-18', '2026-10-24', '2026-10-25'];
  const source = history(candidates.map(date => point(date)));
  for (const [days, expected] of [
    [7, ['2026-10-18', '2026-10-24']],
    [30, ['2026-09-25', '2026-10-17', '2026-10-18', '2026-10-24']],
    [90, ['2026-07-27', '2026-09-24', '2026-09-25', '2026-10-17', '2026-10-18', '2026-10-24']],
  ]) {
    const result = buildItemHistory(source, 'Ruby [7]', [], { days, now: NOW });
    assert.deepEqual(result.points.map(p => p.date), expected);
    assert.equal(result.observationDays, expected.length);
  }
});

test('an old import outside the selected range does not label current-only points as imported history', () => {
  const result = buildItemHistory(history([point('2026-10-17')]), 'Ruby [7]', [offer(80)], { days: 7, now: NOW });
  assert.equal(result.currentOnly, true);
  assert.equal(result.hasImportedHistory, false);
  assert.equal(result.observationDays, 1);
});

test('ignores future observations, including a later time on the current UTC day', () => {
  const result = buildItemHistory(history([point('2026-10-25')]), 'Ruby [7]', [
    offer(1, 'sell', '2026-10-25T00:00:00Z'),
    offer(2, 'sell', '2026-10-24T12:00:00.001Z'),
    offer(3, 'buy', '2026-10-24T12:00:00Z'),
  ], { now: NOW });
  assert.deepEqual(result.points, [{
    date: '2026-10-24', sellMin: null, sellMax: null, buyMin: 3, buyMax: 3, sources: ['current'],
  }]);
});

test('prototype keys are never read as inherited items; own hostile-looking names remain inert', () => {
  const inherited = Object.create({
    ruby: { name: 'Ruby', points: [point('2026-10-20')] },
  });
  assert.deepEqual(buildItemHistory({ version: 1, items: inherited }, 'Ruby', [], { now: NOW }), empty);
  assert.deepEqual(buildItemHistory({ version: 1, items: {} }, '__proto__', [], { now: NOW }), empty);
  assert.deepEqual(buildItemHistory({ version: 1, items: {} }, 'constructor', [], { now: NOW }), empty);
  const own = JSON.parse('{"__proto__":{"name":"__proto__","points":[{"date":"2026-10-20","sellMin":25,"sellMax":30,"buyMin":null,"buyMax":null}]}}');
  const result = buildItemHistory({ version: 1, items: own }, '__proto__', [], { now: NOW });
  assert.equal(result.points[0].sellMin, 25);
  assert.equal(result.hasImportedHistory, true);
  assert.equal(Object.getPrototypeOf(result.points[0]), Object.prototype);
});

test('bad imported dates and invalid or incomplete ranges are skipped without hiding valid points', () => {
  const bad = [
    null, [], point('2026-02-30'), point('2026-10-24T00:00:00Z'),
    point('2026-10-20', { sellMin: -1 }),
    point('2026-10-20', { sellMin: NaN }),
    point('2026-10-20', { sellMax: Infinity }),
    point('2026-10-20', { sellMin: '100' }),
    point('2026-10-20', { sellMin: 1.5 }),
    point('2026-10-20', { sellMax: Number.MAX_SAFE_INTEGER + 1 }),
    point('2026-10-20', { sellMin: 200, sellMax: 100 }),
    point('2026-10-20', { sellMin: null }),
    point('2026-10-20', { buyMin: 50, buyMax: null }),
    { date: '2026-10-20', sellMin: 100, sellMax: 120 },
    point('2026-10-20', { sellMin: null, sellMax: null }),
  ];
  const result = buildItemHistory(history([...bad, point('2026-10-21', { sellMin: 0, sellMax: 0 })]), 'Ruby [7]', [], { now: NOW });
  assert.deepEqual(result.points, [{
    date: '2026-10-21', sellMin: 0, sellMax: 0, buyMin: null, buyMax: null, sources: ['history'],
  }]);
});

test('rejects invalid current timestamps, prices, types and names instead of coercing them', () => {
  const invalid = [
    null, [], offer(1, 'sell', 'not a timestamp'),
    offer(1, 'sell', '2026-10-24'), offer(1, 'sell', '2026-02-30T01:00:00Z'),
    offer(1, 'sell', '2026-10-23T24:00:00Z'), offer(1, 'sell', '2026-10-24T01:00:00'),
    offer('1'), offer(-1), offer(Infinity), offer(NaN), offer(1.5), offer(Number.MAX_SAFE_INTEGER + 1),
    offer(1, 'trade'), offer(1, 'sell', '2026-10-24T01:00:00Z', null),
  ];
  assert.deepEqual(buildItemHistory(null, 'Ruby [7]', invalid, { now: NOW }), empty);
});

test('rejects a mismatched keyed item and unsupported dataset versions but still uses valid current offers', () => {
  const wrongName = history([point('2026-10-20')]);
  wrongName.items['ruby [7]'].name = 'Emerald [7]';
  for (const source of [null, [], { version: 2, items: history([]).items }, { version: 1, items: [] }, wrongName]) {
    const result = buildItemHistory(source, 'Ruby [7]', [offer(9)], { now: NOW });
    assert.equal(result.currentOnly, true);
    assert.equal(result.observationDays, 1);
    assert.equal(result.points[0].sellMin, 9);
  }
});

test('returns chronological new objects without mutating source points or offer arrays', () => {
  const source = history([point('2026-10-24'), point('2026-10-20')]);
  const current = [offer(80, 'buy', '2026-10-21T00:00:00Z')];
  const before = structuredClone({ source, current });
  const result = buildItemHistory(source, 'Ruby [7]', current, { now: NOW });
  assert.deepEqual(result.points.map(p => p.date), ['2026-10-20', '2026-10-21', '2026-10-24']);
  assert.deepEqual({ source, current }, before);
  result.points[0].sellMin = 1;
  assert.equal(source.items['ruby [7]'].points[1].sellMin, 100);
});

test('missing matches, bad clocks and empty input produce an explicit empty result', () => {
  assert.deepEqual(buildItemHistory(null, '', [], { now: NOW }), empty);
  assert.deepEqual(buildItemHistory(history([]), null, [], { now: NOW }), empty);
  assert.deepEqual(buildItemHistory(null, 'Ruby [7]', undefined, { now: NOW }), empty);
  for (const now of [NaN, Infinity, '2026-10-24', null, 9e20]) {
    assert.deepEqual(buildItemHistory(history([point('2026-10-24')]), 'Ruby [7]', [offer(1)], { now }), empty);
  }
});
