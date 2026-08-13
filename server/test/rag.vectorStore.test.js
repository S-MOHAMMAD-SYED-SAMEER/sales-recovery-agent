import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVectorStore } from '../src/rag/vectorStore.js';

// The Chroma JS client keeps its base URL in a closure — there's no property
// to read it back from. But it issues its requests through the global fetch,
// so stubbing that captures the URL the client actually builds. This asserts
// on real observable behaviour (the scheme on the wire) rather than on the
// arguments we happened to pass, and it needs no running Chroma server: the
// first request is intercepted before it ever leaves the process.
async function captureRequestUrl(storeArgs) {
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input) => {
    urls.push(typeof input === 'string' ? input : input.url);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    // Any operation triggers the lazy getOrCreateCollection. The stubbed
    // response isn't a valid collection payload, so the call rejects — that's
    // fine and expected; the URL has already been captured by then.
    await createVectorStore(storeArgs)
      .count()
      .catch(() => {});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(urls.length > 0, 'expected the Chroma client to issue at least one request');
  return urls[0];
}

test('builds a plain-http URL when ssl is omitted — local dev behaviour is unchanged', async () => {
  const url = await captureRequestUrl({ host: 'localhost', port: 8000, collectionName: 'kb' });
  assert.ok(url.startsWith('http://localhost:8000/'), `expected plain http, got ${url}`);
});

test('builds a plain-http URL when ssl is explicitly false', async () => {
  const url = await captureRequestUrl({
    host: 'localhost',
    port: 8000,
    ssl: false,
    collectionName: 'kb',
  });
  assert.ok(url.startsWith('http://localhost:8000/'), `expected plain http, got ${url}`);
});

test('builds an https URL when ssl is true — the hosted-Chroma case', async () => {
  const url = await captureRequestUrl({
    host: 'sales-recovery-chroma.onrender.com',
    port: 443,
    ssl: true,
    collectionName: 'kb',
  });
  assert.ok(
    url.startsWith('https://sales-recovery-chroma.onrender.com/'),
    `expected https, got ${url}`
  );
});

test('a non-default port is preserved alongside ssl', async () => {
  const url = await captureRequestUrl({
    host: 'example.com',
    port: 8443,
    ssl: true,
    collectionName: 'kb',
  });
  assert.ok(url.startsWith('https://example.com:8443/'), `expected https on 8443, got ${url}`);
});
