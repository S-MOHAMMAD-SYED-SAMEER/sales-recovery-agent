import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetriever } from '../src/rag/retriever.js';

const fakeEmbedText = async () => [0, 0, 0];

function fakeVectorStore(matches) {
  return { async query() { return matches; } };
}

test('returns relevant matches formatted with source, heading, text, and score', async () => {
  const vectorStore = fakeVectorStore([
    { id: 'a', text: 'Shipping info', metadata: { source: 'shipping.md', heading: 'H' }, score: 0.8 },
  ]);
  const retriever = createRetriever({ vectorStore, embedText: fakeEmbedText });

  const results = await retriever.retrieve('shipping question');

  assert.deepEqual(results, [{ source: 'shipping.md', heading: 'H', text: 'Shipping info', score: 0.8 }]);
});

test('filters out matches below the relevance threshold — irrelevant content is not returned', async () => {
  const vectorStore = fakeVectorStore([
    { id: 'a', text: 'Relevant', metadata: { source: 'x.md', heading: 'H' }, score: 0.8 },
    { id: 'b', text: 'Borderline', metadata: { source: 'y.md', heading: 'H' }, score: 0.4 },
    { id: 'c', text: 'Irrelevant', metadata: { source: 'z.md', heading: 'H' }, score: 0.1 },
  ]);
  const retriever = createRetriever({ vectorStore, embedText: fakeEmbedText });

  const results = await retriever.retrieve('query', { minScore: 0.35 });

  assert.deepEqual(results.map((r) => r.text), ['Relevant', 'Borderline']);
});

test('returns an empty array when nothing clears the threshold', async () => {
  const vectorStore = fakeVectorStore([{ id: 'a', text: 'x', metadata: { source: 'x.md', heading: 'H' }, score: 0.05 }]);
  const retriever = createRetriever({ vectorStore, embedText: fakeEmbedText });

  assert.deepEqual(await retriever.retrieve('unrelated query'), []);
});

test('preserves source metadata for each result, even across multiple sources', async () => {
  const vectorStore = fakeVectorStore([
    { id: 'a', text: 'From shipping', metadata: { source: 'shipping-policy.md', heading: 'Intl' }, score: 0.7 },
    { id: 'b', text: 'From returns', metadata: { source: 'returns-policy.md', heading: 'Window' }, score: 0.6 },
  ]);
  const retriever = createRetriever({ vectorStore, embedText: fakeEmbedText });

  const results = await retriever.retrieve('query');
  assert.deepEqual(results.map((r) => r.source), ['shipping-policy.md', 'returns-policy.md']);
  assert.deepEqual(results.map((r) => r.heading), ['Intl', 'Window']);
});

test('passes topK through to the vector store query', async () => {
  let seenOptions;
  const vectorStore = {
    async query(embedding, options) {
      seenOptions = options;
      return [];
    },
  };
  const retriever = createRetriever({ vectorStore, embedText: fakeEmbedText });

  await retriever.retrieve('q', { topK: 7 });
  assert.equal(seenOptions.topK, 7);
});
