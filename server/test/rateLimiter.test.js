import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRateLimiter } from '../src/middleware/rateLimiter.js';

// A clock a test moves by hand, so window-expiry assertions are exact and
// instant — no real setTimeout/sleep anywhere in this file.
function fakeClock(start = 0) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
  };
  return clock;
}

function fakeReqRes(ip) {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
  return { req: { ip }, res };
}

// --- pure middleware behavior, no HTTP server needed ------------------

test('requests under the limit all succeed', () => {
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, clock: fakeClock() });
  const { req, res } = fakeReqRes('1.2.3.4');
  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
  };

  limiter(req, res, next);
  limiter(req, res, next);
  limiter(req, res, next);

  assert.equal(nextCalls, 3);
  assert.equal(res.statusCode, null);
});

test('the request over the limit returns 429 with a useful error body', () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, clock: fakeClock() });
  const { req, res } = fakeReqRes('1.2.3.4');
  const next = () => {};

  limiter(req, res, next);
  limiter(req, res, next);
  limiter(req, res, next); // over the limit

  assert.equal(res.statusCode, 429);
  assert.match(res.body.error, /too many requests/i);
});

test('a 429 response includes a Retry-After header', () => {
  const clock = fakeClock(1_000);
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, clock });
  const { req, res } = fakeReqRes('1.2.3.4');
  const next = () => {};

  limiter(req, res, next);
  limiter(req, res, next); // over the limit

  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers['Retry-After']) > 0);
});

test('the blocked request does not call next()', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, clock: fakeClock() });
  const { req, res } = fakeReqRes('1.2.3.4');
  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
  };

  limiter(req, res, next);
  limiter(req, res, next);

  assert.equal(nextCalls, 1);
});

test('the budget recovers once the sliding window has fully passed', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 1, windowMs: 10_000, clock });
  const { req, res } = fakeReqRes('1.2.3.4');
  const next = () => {};

  limiter(req, res, next);
  limiter(req, res, next); // blocked
  assert.equal(res.statusCode, 429);

  clock.advance(10_001);
  res.statusCode = null;
  limiter(req, res, next);

  assert.equal(res.statusCode, null);
});

test('only admissions still inside the window count toward the limit', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ limit: 2, windowMs: 10_000, clock });
  const { req, res } = fakeReqRes('1.2.3.4');
  const next = () => {};

  limiter(req, res, next); // t=0
  clock.advance(6_000);
  limiter(req, res, next); // t=6000 — both still in window
  assert.equal(res.statusCode, null);

  limiter(req, res, next); // t=6000 — third request, still within the window: blocked
  assert.equal(res.statusCode, 429);

  clock.advance(4_001); // t=10001 — the t=0 admission has aged out
  res.statusCode = null;
  limiter(req, res, next);
  assert.equal(res.statusCode, null);
});

test('different client IPs have independent limits', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, clock: fakeClock() });
  const a = fakeReqRes('1.1.1.1');
  const b = fakeReqRes('2.2.2.2');
  const next = () => {};

  limiter(a.req, a.res, next);
  limiter(a.req, a.res, next); // a is over its limit
  limiter(b.req, b.res, next); // b has its own, untouched budget

  assert.equal(a.res.statusCode, 429);
  assert.equal(b.res.statusCode, null);
});

test('a request with no identifiable client falls back to one shared key rather than throwing', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, clock: fakeClock() });
  const req = { ip: undefined, socket: {} };
  const res = fakeReqRes().res;
  assert.doesNotThrow(() => limiter(req, res, () => {}));
});

// --- "disabled/overridden in tests" -----------------------------------

test('a test can override the limiter with an effectively unlimited budget instead of the default', () => {
  // The documented way to "disable" it for a test that would otherwise trip
  // it: build a dedicated instance with a very high limit, rather than any
  // global on/off switch — there is no shared/global limiter state to flip.
  const limiter = createRateLimiter({ limit: Number.MAX_SAFE_INTEGER, windowMs: 60_000, clock: fakeClock() });
  const { req, res } = fakeReqRes('1.2.3.4');
  const next = () => {};

  for (let i = 0; i < 500; i += 1) limiter(req, res, next);

  assert.equal(res.statusCode, null);
});

test('each createRateLimiter(...) instance has its own isolated state', () => {
  const clock = fakeClock();
  const a = createRateLimiter({ limit: 1, windowMs: 60_000, clock });
  const b = createRateLimiter({ limit: 1, windowMs: 60_000, clock });
  const { req, res } = fakeReqRes('1.2.3.4');
  const next = () => {};

  a(req, res, next);
  a(req, res, next); // a is exhausted
  assert.equal(res.statusCode, 429);

  res.statusCode = null;
  b(req, res, next); // a fresh instance for the same IP is unaffected
  assert.equal(res.statusCode, null);
});

// --- real HTTP behavior, including /api/health being unaffected -----------

function buildTestApp(limiter) {
  const app = express();
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/chat', limiter);
  app.post('/api/chat', (req, res) => res.json({ ok: true }));
  return app;
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('over HTTP: requests under the limit succeed and the one over it gets a real 429', async () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, clock: fakeClock() });
  const server = await listen(buildTestApp(limiter));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const first = await fetch(`${base}/api/chat`, { method: 'POST' });
    const second = await fetch(`${base}/api/chat`, { method: 'POST' });
    const third = await fetch(`${base}/api/chat`, { method: 'POST' });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.ok(third.headers.get('retry-after'));
  } finally {
    await close(server);
  }
});

test('over HTTP: GET /api/health is never rate-limited, even after /api/chat is exhausted', async () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, clock: fakeClock() });
  const server = await listen(buildTestApp(limiter));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await fetch(`${base}/api/chat`, { method: 'POST' });
    await fetch(`${base}/api/chat`, { method: 'POST' }); // exhausts the /api/chat budget

    for (let i = 0; i < 5; i += 1) {
      const health = await fetch(`${base}/api/health`);
      assert.equal(health.status, 200);
    }
  } finally {
    await close(server);
  }
});
