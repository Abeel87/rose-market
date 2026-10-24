import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProfitability } from '../dist/profit.js';

const near = (actual, expected, epsilon = 1e-12) => assert.ok(Math.abs(actual - expected) <= epsilon * Math.max(1, Math.abs(expected)), `${actual} ≉ ${expected}`);

test('an omitted or blank cost needs input, while explicit zero is valid', () => {
  for (const cost of [undefined, null, '', '  ']) {
    const result = calculateProfitability({ cost });
    assert.equal(result.status, 'needs-cost');
    assert.equal(result.valid, false);
    assert.equal(result.breakEvenPrice, null);
  }
  const zero = calculateProfitability({ cost: 0, sellPrice: 100 });
  assert.equal(zero.valid, true);
  assert.equal(zero.breakEvenPrice, 0);
  assert.equal(zero.profit, 100);
  assert.equal(zero.roiPercent, null);
});

test('total cost, fixed target profit, net sale and ROI have separate meanings', () => {
  const result = calculateProfitability({ cost: 100, extraCost: 20, targetProfit: 30, sellPrice: 150 });
  assert.deepEqual(result, {
    status: 'ok', valid: true, errors: [], totalCost: 120,
    breakEvenPrice: 120, targetPrice: 150, netRevenue: 150,
    profit: 30, roiPercent: 25, meetsBreakEven: true, meetsTarget: true,
  });
  const atCost = calculateProfitability({ cost: 100, targetProfit: 20, sellPrice: 100 });
  assert.equal(atCost.meetsBreakEven, true);
  assert.equal(atCost.meetsTarget, false);
});

test('exact threshold avoids a one-Zulie overshoot from floating point ceil', () => {
  // Naive JS: Math.ceil(21 / (1 - 30 / 100)) === 31, although 30 × .7 is 21.
  const result = calculateProfitability({ cost: 21, feePercent: 30, targetProfit: 7, sellPrice: 30 });
  assert.equal(result.breakEvenPrice, 30);
  assert.equal(result.targetPrice, 40);
  assert.equal(result.netRevenue, 21);
  assert.equal(result.profit, 0);
  assert.equal(result.roiPercent, 0);
});

test('rounded-up thresholds are the lowest integer prices that meet the requested outcome', () => {
  const args = { cost: 100, feePercent: 5.5, targetProfit: 25 };
  const result = calculateProfitability(args);
  assert.equal(result.breakEvenPrice, 106);
  assert.equal(result.targetPrice, 133);
  assert.equal(calculateProfitability({ ...args, sellPrice: 105 }).meetsBreakEven, false);
  assert.equal(calculateProfitability({ ...args, sellPrice: 106 }).meetsBreakEven, true);
  assert.equal(calculateProfitability({ ...args, sellPrice: 132 }).meetsTarget, false);
  assert.equal(calculateProfitability({ ...args, sellPrice: 133 }).meetsTarget, true);
});

test('actual sale losses remain negative and ROI uses total cost, not revenue', () => {
  const result = calculateProfitability({ cost: 100, extraCost: 10, feePercent: 10, sellPrice: 80 });
  assert.equal(result.netRevenue, 72);
  assert.equal(result.profit, -38);
  near(result.roiPercent, -38 / 110 * 100);
  assert.equal(result.meetsBreakEven, false);
});

test('no selected sale price leaves outcomes unknown without blocking price thresholds', () => {
  const result = calculateProfitability({ cost: 100, targetProfit: 20 });
  assert.equal(result.status, 'ok');
  assert.equal(result.targetPrice, 120);
  for (const field of ['netRevenue', 'profit', 'roiPercent', 'meetsBreakEven', 'meetsTarget']) assert.equal(result[field], null);
  assert.equal(calculateProfitability({ cost: 100, sellPrice: 0 }).profit, -100);
});

test('invalid money and percentage inputs are rejected rather than rounded or guessed', () => {
  for (const change of [
    { cost: -1 }, { cost: .5 }, { cost: Infinity }, { cost: NaN },
    { extraCost: -1 }, { extraCost: null }, { targetProfit: -1 },
    { sellPrice: -1 }, { feePercent: -1 }, { feePercent: 100 },
    { feePercent: Infinity }, { feePercent: null },
    { cost: '9007199254740991.1' }, { cost: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const result = calculateProfitability({ cost: 100, ...change });
    assert.equal(result.status, 'invalid', JSON.stringify(change));
    assert.equal(result.valid, false);
    assert.ok(result.errors.length);
    assert.equal(result.breakEvenPrice, null);
  }
});

test('extreme totals and fees cannot return inaccurate unsafe sale thresholds', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const exact = calculateProfitability({ cost: maximum, sellPrice: maximum });
  assert.equal(exact.breakEvenPrice, maximum);
  assert.equal(exact.netRevenue, maximum);
  assert.equal(exact.profit, 0);
  assert.equal(calculateProfitability({ cost: maximum, extraCost: 1 }).status, 'invalid');
  assert.equal(calculateProfitability({ cost: maximum, feePercent: 1 }).status, 'invalid');
  assert.equal(calculateProfitability({ cost: 1, targetProfit: maximum }).status, 'invalid');
  assert.equal(calculateProfitability({ cost: 1, feePercent: 99.99999999999999 }).status, 'invalid');
});

test('tiny finite percentage fees keep exact threshold and profit-sign decisions', () => {
  const result = calculateProfitability({ cost: 1, feePercent: 1e-200, sellPrice: 1 });
  assert.equal(result.status, 'ok');
  assert.equal(result.breakEvenPrice, 2);
  assert.equal(result.meetsBreakEven, false);
  assert.ok(result.profit < 0);
  assert.ok(Number.isFinite(result.netRevenue));
});

test('Polish numeric text is supported without treating a missing price as zero', () => {
  const result = calculateProfitability({ cost: '1 000', extraCost: '20,00', feePercent: '2,5', targetProfit: '0' });
  assert.equal(result.status, 'ok');
  assert.equal(result.totalCost, 1020);
  assert.equal(result.breakEvenPrice, 1047);
  assert.equal(result.netRevenue, null);
});
