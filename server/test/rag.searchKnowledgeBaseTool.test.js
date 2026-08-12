import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecute } from '../src/rag/searchKnowledgeBaseTool.js';
import { ToolValidationError } from '../src/tools/errors.js';

test('returns found:true with source-attributed results when the retriever finds matches', async () => {
  const fakeRetriever = {
    retrieve: async () => [{ source: 'shipping-policy.md', heading: 'International', text: 'Ships in 7-12 days.', score: 0.7123 }],
  };
  const execute = buildExecute(fakeRetriever);

  const result = await execute({ query: 'how long is international shipping' });

  assert.equal(result.found, true);
  assert.equal(result.results[0].source, 'shipping-policy.md');
  assert.equal(result.results[0].heading, 'International');
  assert.equal(result.results[0].relevance, 0.712);
});

test('returns found:false with a do-not-guess instruction when nothing relevant is found', async () => {
  const execute = buildExecute({ retrieve: async () => [] });

  const result = await execute({ query: 'something the KB does not cover' });

  assert.equal(result.found, false);
  assert.match(result.message, /do not guess/i);
});

test('rejects a missing query as an invalid-argument error', async () => {
  const execute = buildExecute({ retrieve: async () => [] });
  await assert.rejects(() => execute({}), ToolValidationError);
});

test('rejects a blank query as an invalid-argument error', async () => {
  const execute = buildExecute({ retrieve: async () => [] });
  await assert.rejects(() => execute({ query: '   ' }), ToolValidationError);
});
