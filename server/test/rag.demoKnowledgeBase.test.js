import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeBaseRestorer } from '../src/rag/demoKnowledgeBase.js';
import { createIngester } from '../src/rag/ingest.js';

// Regression suite for demo knowledge-base recovery.
//
// The production failure this guards: the demo's vector store runs on an
// ephemeral free tier, so a restart can leave it healthy but empty. Retrieval
// then returns no matches, and the agent tells customers the store has no
// shipping or return policy — a false statement about the business, made
// confidently, while both documents sit committed in the repository.
//
// Everything here runs against fakes: no Chroma, no network, no embedding
// model.

// Stands in for the vector store. `count` is what the restorer inspects to
// decide whether the knowledge base needs rebuilding at all.
function makeVectorStore({ count = 0, failOnCount = false } = {}) {
  const state = { count, countCalls: 0, records: new Map(), deletes: [] };
  return {
    state,
    async count() {
      state.countCalls += 1;
      if (failOnCount) throw new Error('connect ECONNREFUSED 10.0.0.1:8000');
      return state.count;
    },
    async upsert(records) {
      for (const record of records) state.records.set(record.id, record);
      state.count = state.records.size;
    },
    async deleteBySource(source) {
      state.deletes.push(source);
      for (const [id, record] of state.records) {
        if (record.metadata.source === source) state.records.delete(id);
      }
      state.count = state.records.size;
    },
  };
}

function makeIngester({ chunksIngested = 22, filesIngested = 4, fail = false } = {}) {
  const state = { calls: 0 };
  return {
    state,
    async ingestAll() {
      state.calls += 1;
      if (fail) throw new Error('connect ECONNREFUSED 10.0.0.1:8000');
      return { filesIngested, chunksIngested };
    },
  };
}

test('a populated knowledge base is never re-ingested', async () => {
  const vectorStore = makeVectorStore({ count: 22 });
  const ingester = makeIngester();
  const restorer = createKnowledgeBaseRestorer({ vectorStore, ingester });

  const outcome = await restorer.ensurePopulated();

  assert.equal(outcome.restored, false);
  assert.equal(outcome.reason, 'already-populated');
  assert.equal(ingester.state.calls, 0, 'a populated store must not trigger ingestion');
});

test('once a populated store has been seen, later calls cost nothing at all', async () => {
  const vectorStore = makeVectorStore({ count: 22 });
  const ingester = makeIngester();
  const restorer = createKnowledgeBaseRestorer({ vectorStore, ingester });

  await restorer.ensurePopulated();
  await restorer.ensurePopulated();
  await restorer.ensurePopulated();

  // One count() total: every message after the first must not touch the
  // network merely to confirm what is already known.
  assert.equal(vectorStore.state.countCalls, 1);
  assert.equal(ingester.state.calls, 0);
});

test('an empty knowledge base is restored', async () => {
  const vectorStore = makeVectorStore({ count: 0 });
  const ingester = makeIngester({ chunksIngested: 22, filesIngested: 4 });
  const restorer = createKnowledgeBaseRestorer({ vectorStore, ingester });

  const outcome = await restorer.ensurePopulated();

  assert.equal(outcome.restored, true);
  assert.equal(outcome.chunksIngested, 22);
  assert.equal(outcome.filesIngested, 4);
  assert.equal(ingester.state.calls, 1);
});

test('a missing collection is restored the same way as an empty one', async () => {
  // A collection that does not exist is recreated empty by the vector store's
  // own getOrCreateCollection, so it reaches the restorer as count 0 — the
  // case observed on the live demo.
  const vectorStore = makeVectorStore({ count: 0 });
  const ingester = makeIngester();
  const restorer = createKnowledgeBaseRestorer({ vectorStore, ingester });

  assert.equal((await restorer.ensurePopulated()).restored, true);
  assert.equal(ingester.state.calls, 1);
});

test('a restored knowledge base is not ingested a second time', async () => {
  const vectorStore = makeVectorStore({ count: 0 });
  const ingester = makeIngester();
  const restorer = createKnowledgeBaseRestorer({ vectorStore, ingester });

  await restorer.ensurePopulated();
  await restorer.ensurePopulated();

  assert.equal(ingester.state.calls, 1);
});

test('concurrent requests share one restore instead of ingesting in parallel', async () => {
  const vectorStore = makeVectorStore({ count: 0 });
  const ingester = makeIngester();
  const restorer = createKnowledgeBaseRestorer({ vectorStore, ingester });

  // Five customer messages arriving at once against a freshly wiped store.
  const outcomes = await Promise.all([
    restorer.ensurePopulated(),
    restorer.ensurePopulated(),
    restorer.ensurePopulated(),
    restorer.ensurePopulated(),
    restorer.ensurePopulated(),
  ]);

  assert.equal(ingester.state.calls, 1, 'single-flight: exactly one ingestion');
  for (const outcome of outcomes) assert.equal(outcome.restored, true);
});

test('repeated restoration is idempotent — no duplicate ids, no growth', async () => {
  // Drives the real ingester over real files so the deterministic-id and
  // delete-before-re-add behaviour is genuinely exercised, not stubbed.
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-restore-test-'));
  fs.writeFileSync(
    path.join(kbDir, 'shipping-policy.md'),
    '# Shipping Policy\n\n## International\n\nSeven to twelve business days.\n\n## Domestic\n\nTwo days.'
  );

  const vectorStore = makeVectorStore({ count: 0 });
  const ingester = createIngester({
    vectorStore,
    embedBatch: async (texts) => texts.map((_, i) => [i, i + 1, i + 2]),
    kbDir,
  });

  // Three separate restorers: each one starts without the "known populated"
  // flag, the way a redeployed process would.
  for (let i = 0; i < 3; i += 1) {
    const restorer = createKnowledgeBaseRestorer({ vectorStore, ingester });
    await restorer.ensurePopulated();
  }

  const ids = [...vectorStore.state.records.keys()];
  assert.equal(ids.length, 2, 'the same two chunks, however many times it runs');
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  // Only the first pass ingested; the store was populated for the other two.
  assert.equal(vectorStore.state.count, 2);
});

test('a failed restore is reported, not thrown, and backs off before retrying', async () => {
  const vectorStore = makeVectorStore({ count: 0 });
  const ingester = makeIngester({ fail: true });
  let clock = 1_000;
  const restorer = createKnowledgeBaseRestorer({
    vectorStore,
    ingester,
    retryCooldownMs: 60_000,
    now: () => clock,
  });

  const first = await restorer.ensurePopulated();
  assert.equal(first.restored, false);
  assert.equal(first.reason, 'failed', 'a failure must be reported, never thrown');

  // Immediately afterwards: still cooling down, no second ingestion attempt.
  const second = await restorer.ensurePopulated();
  assert.equal(second.reason, 'cooling-down');
  assert.equal(ingester.state.calls, 1);

  // Ten more messages in the cooldown window must not add attempts — this is
  // what stops a broken store being hammered by every customer message.
  for (let i = 0; i < 10; i += 1) await restorer.ensurePopulated();
  assert.equal(ingester.state.calls, 1);

  // After the cooldown, one further attempt is allowed. Bounded retry, never
  // an infinite loop.
  clock += 60_001;
  await restorer.ensurePopulated();
  assert.equal(ingester.state.calls, 2);
});

test('an unreachable store fails safely and can still recover later', async () => {
  const vectorStore = makeVectorStore({ count: 0, failOnCount: true });
  const ingester = makeIngester();
  let clock = 0;
  const restorer = createKnowledgeBaseRestorer({
    vectorStore,
    ingester,
    retryCooldownMs: 1_000,
    now: () => clock,
  });

  assert.equal((await restorer.ensurePopulated()).reason, 'failed');
  assert.equal(ingester.state.calls, 0, 'no ingestion attempted when the store cannot be read');

  // The store comes back. A later request must be able to recover — the
  // process should not need restarting.
  const recovered = makeVectorStore({ count: 0 });
  const recoveredRestorer = createKnowledgeBaseRestorer({
    vectorStore: recovered,
    ingester,
    now: () => (clock += 2_000),
  });
  assert.equal((await recoveredRestorer.ensurePopulated()).restored, true);
});

test('a store that reports zero after ingestion is not marked populated', async () => {
  // Defensive: if ingestion somehow writes nothing, the restorer must not
  // latch "populated" and stop trying forever.
  const vectorStore = makeVectorStore({ count: 0 });
  const ingester = makeIngester({ chunksIngested: 0, filesIngested: 0 });
  const restorer = createKnowledgeBaseRestorer({ vectorStore, ingester });

  const outcome = await restorer.ensurePopulated();

  assert.equal(outcome.restored, false);
  const second = await restorer.ensurePopulated();
  assert.notEqual(second.reason, 'already-populated');
});
