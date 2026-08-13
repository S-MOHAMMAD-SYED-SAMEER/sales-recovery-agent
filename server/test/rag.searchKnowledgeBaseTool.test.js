import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecute } from '../src/rag/searchKnowledgeBaseTool.js';
import { ToolValidationError } from '../src/tools/errors.js';
import { createToolExecutor } from '../src/tools/index.js';
import { validateReply } from '../src/guardrails/index.js';

// A retrieval failure carrying exactly the kind of detail that must never
// reach a customer: hostname, port, URL, file path, and env var name.
const LEAKY_ERROR = new Error(
  'connect ECONNREFUSED sales-recovery-chroma.onrender.com:443 ' +
    'at https://sales-recovery-chroma.onrender.com/api/v2/collections ' +
    '(CHROMA_HOST) /app/sales-recovery-agent/server/src/rag/vectorStore.js:71'
);

const INFRASTRUCTURE_TERMS = [
  'chroma',
  'onrender',
  'render',
  'econnrefused',
  '443',
  'http',
  'localhost',
  'CHROMA_HOST',
  'vectorStore',
  '/app/',
  '.js:',
];

function assertNoInfrastructureLeak(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const term of INFRASTRUCTURE_TERMS) {
    assert.ok(
      !serialized.includes(term.toLowerCase()),
      `tool result must not expose "${term}" — got: ${JSON.stringify(value)}`
    );
  }
}

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

// --- Retrieval-failure handling -------------------------------------------
// A knowledge base that is *unreachable* is a different thing from one that
// has *nothing relevant*. These lock in that the two stay distinguishable and
// that the unreachable case produces wording this codebase chose, not wording
// the model improvised from a technical error string.

test('a successful lookup is never marked unavailable', async () => {
  const execute = buildExecute({
    retrieve: async () => [
      { source: 'returns-policy.md', heading: 'Window', text: '30 days.', score: 0.66 },
    ],
  });

  const result = await execute({ query: 'return window' });

  assert.equal(result.found, true);
  assert.equal(result.unavailable, undefined);
});

test('the not-found path stays distinct from a retrieval failure', async () => {
  const notFound = await buildExecute({ retrieve: async () => [] })({ query: 'price matching' });
  const failed = await buildExecute({
    retrieve: async () => {
      throw LEAKY_ERROR;
    },
  })({ query: 'price matching' });

  // Both are "no answer", but only one means the store genuinely has no such
  // information — the other must not be reported to the customer that way.
  assert.equal(notFound.found, false);
  assert.equal(notFound.unavailable, undefined);
  assert.match(notFound.message, /do not guess/i);

  assert.equal(failed.found, false);
  assert.equal(failed.unavailable, true);
  assert.match(failed.message, /temporary/i);
  assert.match(failed.message, /do not tell the customer the information does not exist/i);
});

test('a retrieval failure returns the controlled customer-facing sentence', async () => {
  const execute = buildExecute({
    retrieve: async () => {
      throw LEAKY_ERROR;
    },
  });

  const result = await execute({ query: 'how long does international shipping take' });

  assert.equal(result.found, false);
  assert.equal(result.unavailable, true);
  assert.ok(
    result.message.includes(
      'Sorry, I couldn\'t access that store information right now. Please try again in a moment.'
    ),
    'the exact customer-facing sentence should be supplied by the tool'
  );
});

test('the raw error message is never returned to the caller', async () => {
  const execute = buildExecute({
    retrieve: async () => {
      throw LEAKY_ERROR;
    },
  });

  const result = await execute({ query: 'shipping' });

  assert.ok(!JSON.stringify(result).includes(LEAKY_ERROR.message));
  assertNoInfrastructureLeak(result);
});

test('no infrastructure detail leaks through the dispatcher either', async () => {
  // End to end through the real dispatcher — the path the agent actually uses.
  const executeTool = createToolExecutor([
    {
      name: 'searchKnowledgeBase',
      description: 'd',
      parameters: {},
      execute: buildExecute({
        retrieve: async () => {
          throw LEAKY_ERROR;
        },
      }),
    },
  ]);

  const outcome = await executeTool('searchKnowledgeBase', { query: 'returns' });

  // The failure is now a normal, successful tool result carrying a controlled
  // message — not a thrown error the dispatcher has to describe generically.
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.unavailable, true);
  assertNoInfrastructureLeak(outcome);
});

test('an invalid query is still a validation error, not swallowed as a failure', async () => {
  const execute = buildExecute({
    retrieve: async () => {
      throw LEAKY_ERROR;
    },
  });

  // The failure handler must not catch this — bad input is a different bug
  // class from an unreachable knowledge base, and the dispatcher reports it
  // differently on purpose.
  await assert.rejects(() => execute({}), ToolValidationError);
});

test('guardrails still pass the unavailable reply through unchanged', async () => {
  const reply = "Sorry, I couldn't access that store information right now. Please try again in a moment.";

  const result = validateReply({ reply, toolsUsed: ['searchKnowledgeBase'] });

  // The sentence must not trip any policy — particularly not the
  // policy-timeframe or refund-promise ones — or the guardrail would replace
  // this considered wording with the generic safe fallback.
  assert.equal(result.safe, true);
  assert.equal(result.finalReply, reply);
  assert.deepEqual(result.violations, []);
});
