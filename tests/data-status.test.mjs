import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_END_AT, syncLabel } from '../dist/data-status.js';
import { buildItemHistory } from '../dist/chart-data.js';

test('retired sources are explained as archives, including contradictory success flags', () => {
  for (const success of [false, true, undefined]) {
    const label = syncLabel({ reason: 'source_retired', success, dataChanged: true });
    assert.match(label, /archiwum/);
    assert.match(label, /zakończyło aktualizacje 24\.10\.2026/);
    assert.doesNotMatch(label, /pobrano|błąd/);
  }
});

test('known retirement stays visible when the downloaded status is missing or a cached success', () => {
  for (const status of [null, undefined, { success: true, dataChanged: true }, { success: true, dataChanged: false }]) {
    assert.match(syncLabel(status, { sourceRetired: true }), /archiwum.*zakończyło/);
  }
  // Other sources keep their ordinary download diagnostics.
  assert.match(syncLabel({ success: false }), /błąd/);
  assert.match(syncLabel({ success: true, dataChanged: false }), /bez zmian/);
});

test('archived chart ranges retain original dates and never include later offers', () => {
  const offers = [
    { itemName: 'Steel', type: 'sell', price: 100, seenAt: '2026-10-24T06:17:11.000Z' },
    { itemName: 'Steel', type: 'sell', price: 999, seenAt: '2026-10-25T06:17:11.000Z' },
  ];
  const result = buildItemHistory(null, 'Steel', offers, { days: 7, now: ARCHIVE_END_AT });
  assert.equal(result.points.length, 1);
  assert.equal(result.firstDate, '2026-10-24');
  assert.equal(result.lastDate, '2026-10-24');
  assert.equal(result.points[0].sellMin, 100);
  assert.equal(result.points[0].sellMax, 100);
});
