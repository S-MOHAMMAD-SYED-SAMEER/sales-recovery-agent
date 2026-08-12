import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIngester } from '../src/rag/ingest.js';

// A fake vector store that behaves like the real Chroma-backed one closely
// enough to test ingest.js's logic (upsert-by-id, delete-before-re-add)
// without a running Chroma server or the local embedding model.
function makeFakeVectorStore() {
  const store = new Map();
  const calls = { upserts: [], deletes: [] };
  return {
    calls,
    _store: store,
    async upsert(records) {
      calls.upserts.push(records);
      for (const r of records) store.set(r.id, r);
    },
    async deleteBySource(source) {
      calls.deletes.push(source);
      for (const [id, r] of store) {
        if (r.metadata.source === source) store.delete(id);
      }
    },
    async count() {
      return store.size;
    },
  };
}

function makeTempKbDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-ingest-test-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const fakeEmbedBatch = async (texts) => texts.map((_, i) => [i, i + 1, i + 2]);

test('ingests a markdown file into the vector store with deterministic ids and source metadata', async () => {
  const kbDir = makeTempKbDir({ 'a.md': '# A\n\n## One\n\nContent one.\n\n## Two\n\nContent two.' });
  const vectorStore = makeFakeVectorStore();
  const ingester = createIngester({ vectorStore, embedBatch: fakeEmbedBatch, kbDir });

  const result = await ingester.ingestAll();

  assert.equal(result.filesIngested, 1);
  assert.equal(result.chunksIngested, 2);
  const records = vectorStore.calls.upserts[0];
  assert.deepEqual(records.map((r) => r.id), ['a.md::0', 'a.md::1']);
  for (const r of records) {
    assert.equal(r.metadata.source, 'a.md');
  }
});

test('re-ingesting the same unchanged file is idempotent — no duplicate chunks', async () => {
  const kbDir = makeTempKbDir({ 'a.md': '# A\n\n## One\n\nContent.' });
  const vectorStore = makeFakeVectorStore();
  const ingester = createIngester({ vectorStore, embedBatch: fakeEmbedBatch, kbDir });

  await ingester.ingestAll();
  await ingester.ingestAll();

  assert.equal(await vectorStore.count(), 1);
  assert.equal(vectorStore.calls.deletes.length, 2);
});

test('re-ingesting a file that now has fewer sections removes the stale extra chunks', async () => {
  const kbDir = makeTempKbDir({ 'a.md': '# A\n\n## One\n\nContent one.\n\n## Two\n\nContent two.' });
  const vectorStore = makeFakeVectorStore();
  const ingester = createIngester({ vectorStore, embedBatch: fakeEmbedBatch, kbDir });
  await ingester.ingestAll();
  assert.equal(await vectorStore.count(), 2);

  fs.writeFileSync(path.join(kbDir, 'a.md'), '# A\n\n## One\n\nContent one.');
  await ingester.ingestAll();

  assert.equal(await vectorStore.count(), 1);
});

test('ingesting multiple files keeps chunks correctly attributed to their own source', async () => {
  const kbDir = makeTempKbDir({
    'a.md': '# A\n\n## Sec\n\nFrom A.',
    'b.md': '# B\n\n## Sec\n\nFrom B.',
  });
  const vectorStore = makeFakeVectorStore();
  const ingester = createIngester({ vectorStore, embedBatch: fakeEmbedBatch, kbDir });

  const result = await ingester.ingestAll();

  assert.equal(result.filesIngested, 2);
  assert.equal(await vectorStore.count(), 2);
  const sources = [...vectorStore._store.values()].map((r) => r.metadata.source).sort();
  assert.deepEqual(sources, ['a.md', 'b.md']);
});

test('a genuinely empty file produces zero chunks without erroring', async () => {
  const kbDir = makeTempKbDir({ 'empty.md': '\n' });
  const vectorStore = makeFakeVectorStore();
  const ingester = createIngester({ vectorStore, embedBatch: fakeEmbedBatch, kbDir });

  const result = await ingester.ingestAll();
  assert.equal(result.chunksIngested, 0);
});

test('a file with prose but no ## headings still becomes one retrievable Overview chunk', async () => {
  const kbDir = makeTempKbDir({ 'plain.md': 'Just some text, no sections at all.\n' });
  const vectorStore = makeFakeVectorStore();
  const ingester = createIngester({ vectorStore, embedBatch: fakeEmbedBatch, kbDir });

  const result = await ingester.ingestAll();
  assert.equal(result.chunksIngested, 1);
});
