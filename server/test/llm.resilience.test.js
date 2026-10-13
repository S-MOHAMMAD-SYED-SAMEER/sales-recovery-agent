import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmResponseError, isRetryable, requestedDelayMs, withRetry } from '../src/llm/resilience.js';

function httpError(status, extra = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
}

// A sleep that records what it was asked for instead of waiting.
function fakeSleep() {
  const calls = [];
  const sleep = async (ms) => {
    calls.push(ms);
  };
  return { sleep, calls };
}

test('rate limits, server errors, timeouts and dropped connections are retryable', () => {
  for (const status of [408, 429, 500, 502, 503, 504, 529]) {
    assert.equal(isRetryable(httpError(status)), true, String(status));
  }
  assert.equal(isRetryable(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  assert.equal(isRetryable(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isRetryable(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
  assert.equal(isRetryable(Object.assign(new Error('x'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })), true);
  assert.equal(isRetryable(new TypeError('fetch failed')), true);
});

test('bad requests, auth failures and ordinary errors are not retryable', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryable(httpError(status)), false, String(status));
  }
  assert.equal(isRetryable(new Error('boom')), false);
  assert.equal(isRetryable(new TypeError('x is not a function')), false);
  assert.equal(isRetryable(undefined), false);
});

test('an unusable response is retryable only when it was flagged as a flaky empty turn', () => {
  assert.equal(isRetryable(new LlmResponseError('blocked')), false);
  assert.equal(isRetryable(new LlmResponseError('empty', { retryable: true })), true);
});

test('the requested delay is read from retry-after-ms, then retry-after (seconds or a date)', () => {
  const headers = (entries) => new Headers(entries);
  assert.equal(requestedDelayMs({ headers: headers({ 'retry-after-ms': '1500' }) }), 1500);
  assert.equal(requestedDelayMs({ headers: headers({ 'retry-after': '3' }) }), 3000);
  assert.equal(requestedDelayMs({ headers: { 'retry-after': '2' } }), 2000);

  const now = () => Date.parse('2026-10-13T12:00:00Z');
  assert.equal(requestedDelayMs({ headers: headers({ 'retry-after': 'Tue, 13 Oct 2026 12:00:07 GMT' }) }, now), 7000);
  assert.equal(requestedDelayMs({ headers: headers({ 'retry-after': 'Tue, 13 Oct 2026 11:00:00 GMT' }) }, now), 0);
});

test('the requested delay is read from the retryDelay detail Gemini puts in a 429 message', () => {
  const body = '{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"28s"}]}}';
  assert.equal(requestedDelayMs(httpError(429, { message: body })), 28_000);
  assert.equal(requestedDelayMs(httpError(429, { message: 'Quota exceeded. Please retry in 12.5s.' })), 12_500);
});

test('no requested delay when the server did not say', () => {
  assert.equal(requestedDelayMs(httpError(503)), undefined);
  assert.equal(requestedDelayMs(undefined), undefined);
});

test('withRetry returns the first success without sleeping', async () => {
  const { sleep, calls } = fakeSleep();
  const result = await withRetry(async () => 'ok', { sleep });
  assert.equal(result, 'ok');
  assert.deepEqual(calls, []);
});

test('withRetry backs off exponentially and succeeds on a later attempt', async () => {
  const { sleep, calls } = fakeSleep();
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw httpError(503);
      return 'ok';
    },
    { maxRetries: 2, baseDelayMs: 500, random: () => 0, sleep }
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(calls, [500, 1000]);
});

test('withRetry adds jitter on top of the backoff, bounded by the base delay', async () => {
  const { sleep, calls } = fakeSleep();
  let attempts = 0;
  await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw httpError(500);
      return 'ok';
    },
    { baseDelayMs: 400, random: () => 0.5, sleep }
  );
  assert.deepEqual(calls, [400 + 200]);
});

test('withRetry honours the server\'s Retry-After over its own backoff', async () => {
  const { sleep, calls } = fakeSleep();
  let attempts = 0;
  await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw httpError(429, { headers: new Headers({ 'retry-after': '4' }) });
      return 'ok';
    },
    { sleep, random: () => 0 }
  );
  assert.deepEqual(calls, [4000]);
});

test('withRetry gives up at once when the server asks for longer than the cap', async () => {
  const { sleep, calls } = fakeSleep();
  let attempts = 0;
  const err = httpError(429, { headers: new Headers({ 'retry-after': '60' }) });
  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw err;
      },
      { maxDelayMs: 15_000, sleep }
    ),
    (thrown) => thrown === err
  );
  assert.equal(attempts, 1);
  assert.deepEqual(calls, []);
});

test('withRetry stops after maxRetries and throws the last error', async () => {
  const { sleep, calls } = fakeSleep();
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw httpError(500, { message: `attempt ${attempts}` });
      },
      { maxRetries: 2, random: () => 0, sleep }
    ),
    /attempt 3/
  );
  assert.equal(attempts, 3);
  assert.equal(calls.length, 2);
});

test('withRetry with maxRetries 0 makes exactly one attempt', async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw httpError(503);
      },
      { maxRetries: 0, sleep: fakeSleep().sleep }
    )
  );
  assert.equal(attempts, 1);
});

test('withRetry does not retry a non-retryable error', async () => {
  const { sleep, calls } = fakeSleep();
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw httpError(401);
      },
      { sleep }
    )
  );
  assert.equal(attempts, 1);
  assert.deepEqual(calls, []);
});

test('withRetry reports each retry to onRetry', async () => {
  const seen = [];
  let attempts = 0;
  await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw httpError(502);
      return 'ok';
    },
    { random: () => 0, sleep: fakeSleep().sleep, onRetry: (info) => seen.push([info.attempt, info.delayMs]) }
  );
  assert.deepEqual(seen, [[1, 500]]);
});
