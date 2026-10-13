import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';

// The app is started for real, on an ephemeral port, and called over HTTP —
// this is what covers src/app.js (the body limit, the error handler, the
// headers, the static files, the rate limiter wiring), which no other test
// reaches because they call handleChat() directly. The demo provider needs no
// key and no network, and an in-memory database keeps it off the disk. Both are
// set before anything imports config/env.js, which reads them once.
process.env.LLM_PROVIDER = 'demo';
process.env.SQLITE_PATH = ':memory:';

const { createApp, JSON_BODY_LIMIT } = await import('../src/app.js');
const { createRateLimiter } = await import('../src/middleware/rateLimiter.js');

const servers = [];

function start(options) {
  return new Promise((resolve) => {
    const server = createApp(options).listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function post(base, body, headers = { 'content-type': 'application/json' }) {
  return fetch(`${base}/api/chat`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

let base;
before(async () => {
  base = await start();
});
after(() => {
  for (const server of servers) server.close();
});

test('the body limit is the documented 16kb', () => {
  assert.equal(JSON_BODY_LIMIT, '16kb');
});

test('a normal chat request is answered by the demo provider', async () => {
  const res = await post(base, { sessionId: 'app-test-1', message: 'Is the Ceramic Mug in stock?' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.reply, /Ceramic Mug/);
  assert.deepEqual(body.toolsUsed, ['checkStock']);
});

test('an oversized body gets a short JSON 413, with no stack trace or file path', async () => {
  const res = await post(base, { sessionId: 'app-test-2', message: 'a'.repeat(200_000) });
  assert.equal(res.status, 413);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: 'Request body is too large.' });
  assert.doesNotMatch(text, /PayloadTooLargeError|node_modules|\.js:\d+|[A-Za-z]:\\|\/Users\//);
});

test('malformed JSON gets a JSON 400', async () => {
  const res = await post(base, '{bad');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid JSON in request body.' });
});

test('X-Powered-By is not sent', async () => {
  for (const url of [`${base}/`, `${base}/api/health`]) {
    const res = await fetch(url);
    assert.equal(res.headers.get('x-powered-by'), null, url);
  }
});

test('/api/health answers and the demo page is served', async () => {
  const health = await fetch(`${base}/api/health`);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /AI Customer Support/);
});

test('a message over 2,000 characters is rejected with a 400 that says why', async () => {
  const res = await post(base, { sessionId: 'app-test-3', message: 'a'.repeat(2001) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at most 2000 characters/);
});

test('a message of exactly 2,000 characters is accepted', async () => {
  const res = await post(base, { sessionId: 'app-test-4', message: 'a'.repeat(2000) });
  assert.equal(res.status, 200);
});

test('a sessionId that is not a short plain string is rejected', async () => {
  const bad = [
    { a: 1 },
    ['x'],
    123,
    'has spaces',
    'semi;colon',
    'a'.repeat(65),
    '../../etc/passwd',
  ];
  for (const sessionId of bad) {
    const res = await post(base, { sessionId, message: 'hello' });
    assert.equal(res.status, 400, JSON.stringify(sessionId));
  }
});

test('the demo page\'s own session id (a UUID) is accepted', async () => {
  const res = await post(base, { sessionId: crypto.randomUUID(), message: 'hello' });
  assert.equal(res.status, 200);
});

test('an unexpected error becomes a generic JSON 500, with nothing internal in it', async () => {
  const broken = Router();
  broken.post('/chat', () => {
    throw new Error('secret internal detail at C:\\app\\server\\src\\thing.js');
  });
  const url = await start({ chatRouter: broken });

  const res = await post(url, { sessionId: 's', message: 'hi' });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: 'Something went wrong. Please try again.' });
  assert.doesNotMatch(text, /secret|thing\.js|C:\\/);
});

test('the rate limiter is wired onto /api/chat only', async () => {
  const url = await start({ rateLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }) });

  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    statuses.push((await post(url, { sessionId: 'rl', message: 'hello' })).status);
  }
  assert.deepEqual(statuses, [200, 200, 429, 429]);

  // Health is never limited.
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
  }
});

test('the 429 response carries a Retry-After header and a JSON body', async () => {
  const url = await start({ rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) });
  await post(url, { sessionId: 'rl2', message: 'hello' });
  const res = await post(url, { sessionId: 'rl2', message: 'hello' });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
  assert.match((await res.json()).error, /Too many requests/);
});
