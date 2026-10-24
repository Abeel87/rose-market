/**
 * Zulie profitability model for comparable prices with the same price basis.
 * No per-item quantity or real in-game fee is assumed. A supplied percentage
 * is a hypothetical proportional fee, with no invented fee-rounding rule.
 */

const MAX_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

function blank(value) {
  return value === null || value === undefined || typeof value === 'string' && !value.trim();
}

function error(field, code, message) {
  return { field, code, message };
}

function emptyResult(status, errors = []) {
  return {
    status,
    valid: false,
    errors,
    totalCost: null,
    breakEvenPrice: null,
    targetPrice: null,
    netRevenue: null,
    profit: null,
    roiPercent: null,
    meetsBreakEven: null,
    meetsTarget: null,
  };
}

/** Parse integer Zulie, keeping a blank distinct from an explicit zero. */
function amount(value, field, errors, allowBlank = false) {
  if (blank(value)) {
    if (!allowBlank) errors.push(error(field, 'missing', 'Podaj kwotę; wpisz 0, jeśli nie ma tego kosztu.'));
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(error(field, 'not-finite', 'Kwota musi być skończoną liczbą.'));
    else if (value < 0) errors.push(error(field, 'negative', 'Kwota nie może być ujemna.'));
    else if (!Number.isInteger(value)) errors.push(error(field, 'not-integer', 'Kwotę w Zulie podaj jako liczbę całkowitą.'));
    else if (!Number.isSafeInteger(value)) errors.push(error(field, 'unsafe-amount', 'Kwota przekracza zakres dokładnych obliczeń.'));
    else return value;
    return null;
  }
  if (typeof value !== 'string' || value.length > 100) {
    errors.push(error(field, 'invalid-amount', 'Podaj nieujemną, całkowitą kwotę w Zulie.'));
    return null;
  }
  const clean = value.trim().replace(/[\s\u00a0\u202f]/g, '');
  // Trailing decimal zeroes are harmless, but fractional amounts are not
  // rounded into integers (important near Number.MAX_SAFE_INTEGER).
  if (!/^[+]?\d+(?:[.,]0+)?$/.test(clean)) {
    errors.push(error(field, 'invalid-amount', 'Podaj nieujemną, całkowitą kwotę w Zulie.'));
    return null;
  }
  const integer = BigInt(clean.replace(/^\+/, '').split(/[.,]/)[0]);
  if (integer > MAX_AMOUNT) {
    errors.push(error(field, 'unsafe-amount', 'Kwota przekracza zakres dokładnych obliczeń.'));
    return null;
  }
  return Number(integer);
}

function percentage(value, errors) {
  let parsed = value;
  if (typeof value === 'string' && value.length <= 100) {
    const clean = value.trim().replace(/[\s\u00a0\u202f]/g, '');
    if (/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(clean)) parsed = Number(clean.replace(',', '.'));
  }
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    errors.push(error('feePercent', 'invalid-percent', 'Podaj skończony procent opłaty od 0 do wartości mniejszej niż 100.'));
    return null;
  }
  if (parsed < 0 || parsed >= 100) {
    errors.push(error('feePercent', 'percent-range', 'Opłata musi wynosić co najmniej 0% i mniej niż 100%.'));
    return null;
  }
  return parsed;
}

/** Exact decimal fraction of the accepted JS percentage's canonical text. */
function decimalFraction(value) {
  const [mantissa, exponentText = '0'] = value.toString().toLowerCase().split('e');
  const fractionDigits = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0;
  const scale = fractionDigits - Number(exponentText);
  let numerator = BigInt(mantissa.replace('.', ''));
  if (scale < 0) numerator *= 10n ** BigInt(-scale);
  return { numerator, denominator: scale > 0 ? 10n ** BigInt(scale) : 1n };
}

const ceilRatio = (numerator, denominator) => (numerator + denominator - 1n) / denominator;

/**
 * Convert a rational to a display Number without first overflowing either
 * BigInt operand to Infinity. Exact sign/threshold decisions never use this.
 */
function rationalNumber(numerator, denominator) {
  if (numerator === 0n) return 0;
  const negative = numerator < 0n;
  const positive = negative ? -numerator : numerator;
  const exponent = positive.toString().length - denominator.toString().length;
  const scale = Math.max(0, 18 - exponent);
  const significant = positive * 10n ** BigInt(scale) / denominator;
  return Number(`${negative ? '-' : ''}${significant}e-${scale}`);
}

/**
 * Calculate break-even and a target fixed profit in Zulie.
 *
 * Integer sale thresholds are calculated exactly:
 *   breakEven = ceil((cost + extraCost) / (1 - feePercent / 100))
 *   target    = ceil((cost + extraCost + targetProfit) / retention)
 *
 * Monetary inputs and the returned sale thresholds are safe integers.
 * netRevenue/profit can be fractional under the hypothetical proportional
 * fee. ROI is profit / totalCost × 100; it is null when totalCost is zero.
 * A blank cost means needs-cost. A blank sellPrice leaves sale outcomes null.
 */
export function calculateProfitability(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return emptyResult('invalid', [error('input', 'invalid-input', 'Podaj ustawienia kalkulatora jako obiekt.')]);
  }
  const { cost, extraCost = 0, feePercent = 0, targetProfit = 0, sellPrice = null } = input;
  const errors = [];
  const costValue = amount(cost, 'cost', errors, true);
  const extraValue = amount(extraCost, 'extraCost', errors);
  const targetValue = amount(targetProfit, 'targetProfit', errors);
  const saleValue = amount(sellPrice, 'sellPrice', errors, true);
  const feeValue = percentage(feePercent, errors);
  if (errors.length) return emptyResult('invalid', errors);
  if (costValue === null) return emptyResult('needs-cost');

  const total = BigInt(costValue) + BigInt(extraValue);
  if (total > MAX_AMOUNT) {
    return emptyResult('invalid', [error('totalCost', 'unsafe-total', 'Suma kosztów przekracza zakres dokładnych obliczeń.')]);
  }
  const fee = decimalFraction(feeValue);
  const denominator = 100n * fee.denominator;
  const retention = denominator - fee.numerator;
  const breakEven = ceilRatio(total * denominator, retention);
  const target = ceilRatio((total + BigInt(targetValue)) * denominator, retention);
  if (breakEven > MAX_AMOUNT || target > MAX_AMOUNT) {
    return emptyResult('invalid', [error(breakEven > MAX_AMOUNT ? 'breakEvenPrice' : 'targetPrice', 'unsafe-threshold', 'Przy tych kosztach i opłacie cena progowa przekracza zakres dokładnych obliczeń.')]);
  }

  const result = {
    status: 'ok',
    valid: true,
    errors: [],
    totalCost: Number(total),
    breakEvenPrice: Number(breakEven),
    targetPrice: Number(target),
    netRevenue: null,
    profit: null,
    roiPercent: null,
    meetsBreakEven: null,
    meetsTarget: null,
  };
  if (saleValue !== null) {
    const netNumerator = BigInt(saleValue) * retention;
    const profitNumerator = netNumerator - total * denominator;
    result.netRevenue = rationalNumber(netNumerator, denominator);
    result.profit = rationalNumber(profitNumerator, denominator);
    result.roiPercent = total === 0n ? null : rationalNumber(profitNumerator * 100n, total * denominator);
    result.meetsBreakEven = profitNumerator >= 0n;
    result.meetsTarget = profitNumerator >= BigInt(targetValue) * denominator;
  }
  return result;
}
