import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRoseutilsConnection, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS } from '../scripts/roseutils-client.mjs';
import { runRoseutilsCheck } from '../scripts/check-roseutils.mjs';

const TEST_TOKEN = 'test-only-credential-never-log';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const dates = () => ({ dates: ['2026-10-24', '2026-10-27'] });
const prices = () => ({ data: [{ item_type: 12, item_id: 34, item_name: 'Test-only item', min_price: 10,
  is_selling: true, last_updated: '2026-10-27T08:00:00Z' }] });

function token(t, value = TEST_TOKEN) {
  const previous = process.env.ROSEUTILS_API_TOKEN;
  if (value === undefined) delete process.env.ROSEUTILS_API_TOKEN;
  else process.env.ROSEUTILS_API_TOKEN = value;
  t.after(() => {
    if (previous === undefined) delete process.env.ROSEUTILS_API_TOKEN;
    else process.env.ROSEUTILS_API_TOKEN = previous;
  });
}

test('missing token performs no HTTP and CLI exits 2 without importing', async t => {
  token(t, '');
  let calls = 0;
  const output = [];
  const exitCode = await runRoseutilsCheck({ fetchImpl: async () => { calls += 1; }, write: s => output.push(s) });
  const result = JSON.parse(output.join(''));
  assert.equal(calls, 0);
  assert.equal(exitCode, 2);
  assert.equal(result.code, 'TOKEN_MISSING');
  assert.equal(result.requestsAttempted, 0);
  assert.equal(result.imported, false);
  assert.equal(result.mode, 'connection_check');
});

test('credential header injection is rejected before any HTTP request', async t => {
  token(t, 'invalid\r\nX-Injected: token');
  const result = await checkRoseutilsConnection({ fetchImpl: () => assert.fail('must not request') });
  assert.equal(result.code, 'TOKEN_INVALID');
  assert.equal(result.requestsAttempted, 0);
  assert.doesNotMatch(JSON.stringify(result), /X-Injected/);
});

test('exactly two GETs send the environment token only to the fixed HTTPS origin', async t => {
  token(t);
  const calls = [];
  const result = await checkRoseutilsConnection({
    baseUrl: 'https://attacker.example',
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(new URL(url).origin, 'https://roseutils.com');
      assert.equal(new URL(url).username, '');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, `Bearer ${TEST_TOKEN}`);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      assert.equal(url.includes(TEST_TOKEN), false);
      return json(calls.length === 1 ? dates() : prices());
    },
  });
  assert.deepEqual(calls, ['https://roseutils.com/api/market/available-dates', 'https://roseutils.com/api/market/prices?per_page=100']);
  assert.equal(result.success, true);
  assert.equal(result.imported, false);
  assert.equal(result.freshnessConfirmed, false);
  assert.equal(result.prices.isCompleteMarket, false);
  assert.equal(result.prices.latestSampleObservationAt, '2026-10-27T08:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_TOKEN));
  assert.doesNotMatch(JSON.stringify(result), /Test-only item/);
});

test('redirect is rejected without forwarding credentials or requesting the target', async t => {
  token(t);
  let calls = 0;
  const result = await checkRoseutilsConnection({ fetchImpl: async () => {
    calls += 1;
    return new Response(TEST_TOKEN, { status: 302, headers: { location: `https://attacker.example/${TEST_TOKEN}` } });
  } });
  assert.equal(calls, 1);
  assert.equal(result.code, 'REDIRECT_REJECTED');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_TOKEN));
  assert.doesNotMatch(JSON.stringify(result), /attacker/);
});

test('invalid observation times are counted as missing instead of rolling into another day', async t => {
  token(t);
  const sample = prices();
  sample.data[0].last_updated = '2026-10-24T24:00:00Z';
  let calls = 0;
  const result = await checkRoseutilsConnection({ fetchImpl: async () => json(++calls === 1 ? dates() : sample) });
  assert.equal(result.prices.validTimestampRows, 0);
  assert.equal(result.prices.missingOrInvalidTimestampRows, 1);
  assert.equal(result.prices.latestSampleObservationAt, null);
  assert.equal(result.freshnessConfirmed, false);
});

test('a fetch adapter that reports a followed redirect also fails closed', async t => {
  token(t);
  const response = json(dates());
  Object.defineProperty(response, 'url', { value: 'https://attacker.example/response' });
  Object.defineProperty(response, 'redirected', { value: true });
  const result = await checkRoseutilsConnection({ fetchImpl: async () => response });
  assert.equal(result.code, 'REDIRECT_REJECTED');
});

for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED'], [503, 'HTTP_ERROR']]) {
  test(`HTTP ${status} never echoes server body, retries or credentials`, async t => {
    token(t);
    let calls = 0;
    const output = [];
    const exitCode = await runRoseutilsCheck({ fetchImpl: async () => {
      calls += 1; return new Response(`Sensitive body ${TEST_TOKEN}`, { status, headers: { 'retry-after': '1' } });
    }, write: s => output.push(s) });
    assert.equal(exitCode, 1);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(output[0]).code, code);
    assert.doesNotMatch(output[0], /Sensitive body|test-only-credential/);
  });
}

test('network exceptions cannot leak their message, cause or token', async t => {
  token(t);
  const output = [];
  await runRoseutilsCheck({ fetchImpl: async () => {
    throw new Error(`Authorization: Bearer ${TEST_TOKEN}`, { cause: new Error(TEST_TOKEN) });
  }, write: s => output.push(s) });
  assert.equal(JSON.parse(output[0]).code, 'NETWORK_ERROR');
  assert.doesNotMatch(output[0], /Authorization|Bearer|test-only-credential|stack|cause/);
});

for (const [name, response, code] of [
  ['invalid JSON', () => new Response(`not json ${TEST_TOKEN}`), 'JSON_INVALID'],
  ['invalid UTF-8', () => new Response(new Uint8Array([0xff, 0xfe])), 'JSON_INVALID'],
  ['empty body', () => new Response(''), 'RESPONSE_EMPTY'],
  ['oversized content length', () => new Response('{}', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }), 'RESPONSE_TOO_LARGE'],
  ['oversized stream', () => new Response(' '.repeat(MAX_RESPONSE_BYTES + 1)), 'RESPONSE_TOO_LARGE'],
  ['unexpected date schema', () => json({ error: TEST_TOKEN }), 'SCHEMA_UNEXPECTED'],
  ['invalid calendar date', () => json({ dates: ['2026-02-30'] }), 'SCHEMA_UNEXPECTED'],
]) {
  test(`${name} fails with a bounded safe diagnostic`, async t => {
    token(t);
    const result = await checkRoseutilsConnection({ fetchImpl: async () => response() });
    assert.equal(result.code, code);
    assert.equal(result.success, false);
    assert.equal(result.requestsAttempted, 1);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_TOKEN));
  });
}

for (const [name, payload, code] of [
  ['unexpected price schema', { prices: [TEST_TOKEN] }, 'SCHEMA_UNEXPECTED'],
  ['invalid row', { data: [{ item_name: TEST_TOKEN }] }, 'SCHEMA_UNEXPECTED'],
  ['negative price', { data: [{ ...prices().data[0], min_price: -1 }] }, 'SCHEMA_UNEXPECTED'],
  ['empty sample', { data: [] }, 'EMPTY_SAMPLE'],
  ['oversized sample', { data: Array.from({ length: 101 }, () => prices().data[0]) }, 'SAMPLE_LIMIT_EXCEEDED'],
]) {
  test(`${name} cannot be reported as a successful connection with market data`, async t => {
    token(t);
    let calls = 0;
    const result = await checkRoseutilsConnection({ fetchImpl: async () => json(++calls === 1 ? dates() : payload) });
    assert.equal(result.code, code);
    assert.equal(result.requestsAttempted, 2);
    assert.equal(result.success, false);
    assert.equal(result.imported, false);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_TOKEN));
  });
}

test('unrecognized keys and string values never become diagnostic output', async t => {
  token(t);
  const row = { ...prices().data[0], item_name: TEST_TOKEN, vendor_name: TEST_TOKEN,
    last_updated: TEST_TOKEN, [TEST_TOKEN]: TEST_TOKEN };
  let calls = 0;
  const output = [];
  const exitCode = await runRoseutilsCheck({ fetchImpl: async () => json(++calls === 1 ? dates() : { data: [row] }), write: s => output.push(s) });
  const result = JSON.parse(output[0]);
  assert.equal(exitCode, 0);
  assert.equal(result.prices.unrecognizedFieldOccurrences, 1);
  assert.equal(result.prices.missingOrInvalidTimestampRows, 1);
  assert.equal(result.prices.latestSampleObservationAt, null);
  assert.equal(result.prices.fields.includes('vendor_name'), true);
  assert.doesNotMatch(output[0], new RegExp(TEST_TOKEN));
});

test('20 second deadline aborts a stalled request without leaking errors', async t => {
  token(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const promise = checkRoseutilsConnection({ fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  const result = await promise;
  assert.equal(result.code, 'REQUEST_TIMEOUT');
  assert.equal(result.requestsAttempted, 1);
  assert.equal(signal.aborted, true);
});
