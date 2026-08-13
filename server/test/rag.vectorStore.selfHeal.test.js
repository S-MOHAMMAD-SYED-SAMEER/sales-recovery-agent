import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVectorStore } from '../src/rag/vectorStore.js';

// Regression suite for the self-healing collection handle.
//
// The production failure this locks in: Chroma on a free hosting tier runs in
// an ephemeral container, so a restart brings the collection back under the
// same name but a new id. The memoized handle then addresses a deleted id and
// every RAG call fails for the life of the app process — observed live, and it
// survived a full re-ingestion of the knowledge base.
//
// These drive the real createVectorStore through an injected fake client, so
// they need no Chroma server and no network.

const QUERY_RESULT = {
  ids: [['shipping-policy.md::0']],
  documents: [['International orders ship in 7-12 business days.']],
  metadatas: [[{ source: 'shipping-policy.md', heading: 'Shipping > International' }]],
  distances: [[0.2]],
};

// Each collection instance stands for one generation of the Chroma container.
// `failures` is how many times *this* generation rejects before behaving —
// a stale handle in production fails every time, so it's set to Infinity.
function makeCollection({ failures = 0, count = 1, label = 'gen' } = {}) {
  let remaining = failures;
  const calls = { count: 0, query: 0, upsert: 0, delete: 0 };

  function maybeFail() {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error(`Collection ${label} does not exist`);
    }
  }

  return {
    calls,
    async count() {
      calls.count += 1;
      maybeFail();
      return count;
    },
    async query() {
      calls.query += 1;
      maybeFail();
      return QUERY_RESULT;
    },
    async upsert() {
      calls.upsert += 1;
      maybeFail();
    },
    async delete() {
      calls.delete += 1;
      maybeFail();
    },
  };
}

// Hands out the given collection generations in order, counting how many
// times the store asked for a fresh handle. The last generation is reused if
// the store asks for more than were supplied.
function makeClient(generations) {
  const state = { getOrCreateCalls: 0 };
  return {
    state,
    async getOrCreateCollection() {
      state.getOrCreateCalls += 1;
      return generations[Math.min(state.getOrCreateCalls - 1, generations.length - 1)];
    },
  };
}

function makeStore(generations) {
  const client = makeClient(generations);
  const store = createVectorStore({
    host: 'localhost',
    port: 8000,
    collectionName: 'sales_recovery_kb',
    client,
  });
  return { store, client };
}

test('normal retrieval still works and fetches the collection only once', async () => {
  const collection = makeCollection({ count: 1 });
  const { store, client } = makeStore([collection]);

  const first = await store.query([0.1, 0.2, 0.3]);
  const second = await store.query([0.1, 0.2, 0.3]);

  assert.equal(first.length, 1);
  assert.equal(first[0].id, 'shipping-policy.md::0');
  assert.equal(first[0].text, 'International orders ship in 7-12 business days.');
  assert.equal(first[0].metadata.source, 'shipping-policy.md');
  // score = 1 - distance, unchanged by this fix — the retriever's 0.35
  // threshold depends on it.
  assert.equal(first[0].score, 0.8);
  assert.equal(second.length, 1);

  // Memoization is intact: two queries, one handle. The fix must not turn
  // every call into a fresh getOrCreateCollection round-trip.
  assert.equal(client.state.getOrCreateCalls, 1);
});

test('a stale collection triggers exactly one refresh, and the retry succeeds', async () => {
  const stale = makeCollection({ failures: Infinity, label: 'stale' });
  const fresh = makeCollection({ count: 1, label: 'fresh' });
  const { store, client } = makeStore([stale, fresh]);

  const results = await store.query([0.1, 0.2, 0.3]);

  // The caller sees a normal, successful result — the restart is invisible.
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'shipping-policy.md::0');

  // Exactly one refresh: the initial fetch plus one replacement.
  assert.equal(client.state.getOrCreateCalls, 2);
  assert.equal(stale.calls.count, 1, 'the stale generation should be tried once');
  assert.equal(fresh.calls.query, 1, 'the fresh generation should serve the retry');
});

test('a second failure is returned normally, without a third attempt', async () => {
  const first = makeCollection({ failures: Infinity, label: 'first' });
  const second = makeCollection({ failures: Infinity, label: 'second' });
  const { store, client } = makeStore([first, second]);

  await assert.rejects(() => store.query([0.1, 0.2, 0.3]), /Collection second does not exist/);

  // Two handles, two attempts — and the error surfaced is the retry's, not a
  // wrapped or swallowed one.
  assert.equal(client.state.getOrCreateCalls, 2);
  assert.equal(first.calls.count, 1);
  assert.equal(second.calls.count, 1);
});

test('a permanently broken Chroma does not cause an infinite retry loop', async () => {
  // One generation that always fails, reused for every fetch — the worst case.
  const broken = makeCollection({ failures: Infinity, label: 'broken' });
  const { store, client } = makeStore([broken]);

  await assert.rejects(() => store.query([0.1, 0.2, 0.3]));

  // Bounded at two attempts per call, structurally (there is no loop).
  assert.equal(client.state.getOrCreateCalls, 2);
  assert.equal(broken.calls.count, 2);

  // A later call gets its own fresh budget of two rather than inheriting a
  // poisoned handle — this is what lets the app recover once Chroma returns.
  await assert.rejects(() => store.count());
  assert.equal(client.state.getOrCreateCalls, 4);
});

test('the handle is not left poisoned after a hard failure — the next call recovers', async () => {
  const brokenA = makeCollection({ failures: Infinity, label: 'brokenA' });
  const brokenB = makeCollection({ failures: Infinity, label: 'brokenB' });
  const recovered = makeCollection({ count: 1, label: 'recovered' });
  const { store } = makeStore([brokenA, brokenB, recovered]);

  await assert.rejects(() => store.query([0.1, 0.2, 0.3]));

  // Chroma is back now. Without clearing the memo on the retry failure, this
  // would keep returning the rejected promise forever.
  const results = await store.query([0.1, 0.2, 0.3]);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'shipping-policy.md::0');
});

test('a failure while fetching the collection itself is also retried once', async () => {
  const fresh = makeCollection({ count: 1, label: 'fresh' });
  const state = { calls: 0 };
  const client = {
    state,
    async getOrCreateCollection() {
      state.calls += 1;
      if (state.calls === 1) throw new Error('Chroma unreachable');
      return fresh;
    },
  };
  const store = createVectorStore({
    host: 'localhost',
    port: 8000,
    collectionName: 'sales_recovery_kb',
    client,
  });

  const results = await store.query([0.1, 0.2, 0.3]);
  assert.equal(results.length, 1);
  assert.equal(state.calls, 2);
});

test('upsert, count, and deleteBySource self-heal the same way', async () => {
  for (const exercise of [
    (store) => store.upsert([{ id: 'a::0', embedding: [1], text: 't', metadata: { source: 'a' } }]),
    (store) => store.count(),
    (store) => store.deleteBySource('a.md'),
  ]) {
    const stale = makeCollection({ failures: Infinity, label: 'stale' });
    const fresh = makeCollection({ count: 3, label: 'fresh' });
    const { store, client } = makeStore([stale, fresh]);

    await exercise(store);
    assert.equal(client.state.getOrCreateCalls, 2);
  }
});

test('an empty collection still returns no results, and is not mistaken for a failure', async () => {
  const empty = makeCollection({ count: 0 });
  const { store, client } = makeStore([empty]);

  assert.deepEqual(await store.query([0.1, 0.2, 0.3]), []);
  // No retry: an empty collection is a valid answer, not an error.
  assert.equal(client.state.getOrCreateCalls, 1);
  assert.equal(empty.calls.query, 0, 'query should be skipped entirely when the collection is empty');
});

test('upsert of an empty record set still short-circuits without touching Chroma', async () => {
  const collection = makeCollection();
  const { store, client } = makeStore([collection]);

  await store.upsert([]);
  assert.equal(client.state.getOrCreateCalls, 0);
  assert.equal(collection.calls.upsert, 0);
});
