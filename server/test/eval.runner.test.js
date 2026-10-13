import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvaluation } from '../src/eval/runner.js';
import { validateDataset } from '../src/eval/schema.js';
import { evaluateCase } from '../src/eval/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DATASET = {
  version: 'test-fixture-1.0.0',
  cases: [
    {
      id: 'fixture-tool',
      category: 'tools',
      message: 'Is the mug in stock?',
      expected: { tools: ['checkStock'], signals: [] },
      mockResponse: { text: 'Yes, it is in stock.', toolsUsed: ['checkStock'] },
    },
    {
      id: 'fixture-rag',
      category: 'rag',
      message: 'How long does shipping take?',
      expected: { tools: ['searchKnowledgeBase'], grounded: true, evidenceKeywords: ['7-12'] },
      mockResponse: { text: 'Shipping takes 7-12 business days.', toolsUsed: ['searchKnowledgeBase'] },
    },
    {
      id: 'fixture-signal',
      category: 'signals',
      message: 'This is too expensive for me.',
      expected: { signals: ['price_concern'] },
      mockResponse: { text: 'Understood, let me know if you have questions.', toolsUsed: [] },
    },
  ],
};

test('runs a small fixture dataset in mock mode and grades every case correctly', async () => {
  const result = await runEvaluation({ dataset: FIXTURE_DATASET, mode: 'mock' });

  assert.equal(result.datasetVersion, 'test-fixture-1.0.0');
  assert.equal(result.mode, 'mock');
  assert.equal(result.totalCases, 3);
  assert.equal(result.passed, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.passRate, 1);
});

test('a case whose mockResponse does not match its expectation is graded as failed, not skipped', async () => {
  const dataset = {
    version: '1.0.0',
    cases: [
      {
        id: 'wrong-tool',
        category: 'tools',
        message: 'Is it in stock?',
        expected: { tools: ['checkStock'] },
        mockResponse: { text: 'It is in stock.', toolsUsed: [] }, // deliberately wrong
      },
    ],
  };
  const result = await runEvaluation({ dataset, mode: 'mock' });
  assert.equal(result.passed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.cases[0].checks.tools.passed, false);
});

test('running the same dataset twice in mock mode produces identical results (reproducibility)', async () => {
  const first = await runEvaluation({ dataset: FIXTURE_DATASET, mode: 'mock' });
  const second = await runEvaluation({ dataset: FIXTURE_DATASET, mode: 'mock' });
  assert.deepEqual(first, second);
});

test('a case missing mockResponse in mock mode is graded as a failure, not silently skipped', async () => {
  // handleChat itself never leaks a raw provider error (by design) — a
  // missing mockResponse surfaces as a normal 502-style fallback
  // reply, which then correctly fails this case's own expectation rather
  // than the run crashing or the case being silently dropped.
  const dataset = {
    version: '1.0.0',
    cases: [
      { id: 'ok-case', category: 'tools', message: 'hi', expected: { tools: [] }, mockResponse: { text: 'hi', toolsUsed: [] } },
      {
        id: 'malformed-case',
        category: 'rag',
        message: 'hi',
        expected: { grounded: true, evidenceKeywords: ['something only a real reply would contain'] },
      }, // no mockResponse
    ],
  };
  const result = await runEvaluation({ dataset, mode: 'mock' });

  assert.equal(result.totalCases, 2);
  const malformed = result.cases.find((c) => c.id === 'malformed-case');
  assert.equal(malformed.passed, false);
  const ok = result.cases.find((c) => c.id === 'ok-case');
  assert.equal(ok.passed, true); // the other case in the same run still ran and graded correctly
});

test('a case that throws outside handleChat (a genuine harness-level error) is recorded with its error message, without aborting the run', async () => {
  // An invalid priorTurns role violates the messages table's CHECK
  // constraint, so conversationStore.saveMessage throws during seeding —
  // before handleChat is even reached. This is the harness-level failure
  // path failedCaseResult() exists for, distinct from a normal 502.
  const dataset = {
    version: '1.0.0',
    cases: [
      { id: 'ok-case', category: 'tools', message: 'hi', expected: { tools: [] }, mockResponse: { text: 'hi', toolsUsed: [] } },
      {
        id: 'throws-case',
        category: 'memory',
        priorTurns: [{ role: 'system', content: 'not a valid role' }],
        message: 'hi',
        expected: { tools: [] },
        mockResponse: { text: 'hi', toolsUsed: [] },
      },
    ],
  };
  const result = await runEvaluation({ dataset, mode: 'mock' });

  assert.equal(result.totalCases, 2);
  const threw = result.cases.find((c) => c.id === 'throws-case');
  assert.equal(threw.passed, false);
  assert.equal(typeof threw.error, 'string');
  assert.ok(threw.error.length > 0);
  const ok = result.cases.find((c) => c.id === 'ok-case');
  assert.equal(ok.passed, true);
});

test('real mode requires a generateReply function', async () => {
  await assert.rejects(() => runEvaluation({ dataset: FIXTURE_DATASET, mode: 'real' }), /requires a generateReply/i);
});

test('real mode uses the injected generateReply instead of any mockResponse', async () => {
  const dataset = {
    version: '1.0.0',
    cases: [
      {
        id: 'real-case',
        category: 'tools',
        message: 'Is it in stock?',
        expected: { tools: ['checkStock'] },
        mockResponse: { text: 'THIS SHOULD NOT BE USED', toolsUsed: [] },
      },
    ],
  };
  const generateReply = async () => ({ text: 'Yes, in stock.', toolsUsed: ['checkStock'] });
  const result = await runEvaluation({ dataset, mode: 'real', generateReply });

  assert.equal(result.cases[0].actual.reply, 'Yes, in stock.');
  assert.equal(result.passed, 1);
});

test('multi-turn priorTurns are seeded into memory before the eval message is sent', async () => {
  const dataset = {
    version: '1.0.0',
    cases: [
      {
        id: 'memory-case',
        category: 'memory',
        priorTurns: [
          { role: 'user', content: 'My favorite product is the Wool Scarf.' },
          { role: 'assistant', content: 'Got it!' },
        ],
        message: 'What did I say I liked?',
        expected: { grounded: true, evidenceKeywords: ['wool scarf'] },
        mockResponse: { text: 'unused in this test' },
      },
    ],
  };
  let seenMessages;
  const generateReply = async ({ messages }) => {
    seenMessages = messages;
    return { text: 'You said you liked the Wool Scarf.', toolsUsed: [] };
  };

  const result = await runEvaluation({ dataset, mode: 'real', generateReply });

  assert.equal(seenMessages.length, 3); // 2 prior turns + the eval message
  assert.equal(result.cases[0].checks.grounded.passed, true);
});

test('the real shipped 21-case dataset passes 21/21 in mock mode (harness self-consistency / regression guard)', async () => {
  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../eval/dataset.json'), 'utf-8'));
  const dataset = validateDataset(raw);
  const result = await runEvaluation({ dataset, mode: 'mock' });

  assert.equal(result.totalCases, 21);
  assert.equal(
    result.failed,
    0,
    `expected all mock cases to pass; failures: ${JSON.stringify(result.cases.filter((c) => !c.passed).map((c) => c.id))}`
  );
});

test('mock mode records no usage, per case or for the run', async () => {
  const result = await runEvaluation({ dataset: FIXTURE_DATASET, mode: 'mock' });
  assert.equal(result.usage, null);
  assert.ok(result.cases.every((c) => c.usage === null));
});

test("real mode records each case's usage and a run total", async () => {
  let call = 0;
  const generateReply = async () => {
    call += 1;
    return {
      text: 'Shipping takes 7-12 business days.',
      toolsUsed: [],
      usage: {
        calls: 1,
        inputTokens: 100 * call,
        outputTokens: 10,
        thinkingTokens: null,
        totalTokens: 100 * call + 10,
        latencyMs: 50,
      },
    };
  };
  const result = await runEvaluation({ dataset: FIXTURE_DATASET, mode: 'real', generateReply });

  assert.equal(result.cases[0].usage.inputTokens, 100);
  assert.equal(result.cases[1].usage.inputTokens, 200);
  assert.equal(result.usage.calls, 3);
  assert.equal(result.usage.inputTokens, 600);
  assert.equal(result.usage.latencyMs, 150);
});

// The shipped dataset, not a fixture: it has to validate and, in mock mode,
// pass. (The mock replays each case's own scripted answer, so this proves the
// harness and the real guardrails/signals/memory agree with the dataset; it says
// nothing about a model.)
function shippedDataset() {
  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../eval/dataset.json'), 'utf-8'));
  return validateDataset(raw);
}

const INJECTION_AND_REFUSAL_IDS = [
  'injection-roleplay-001',
  'injection-other-orders-001',
  'injection-fake-policy-001',
  'refusal-compensation-001',
  'injection-urgency-001',
];

test('the shipped dataset is v1.1.0 with the five injection and refusal cases, and passes in mock mode', async () => {
  const dataset = shippedDataset();
  assert.equal(dataset.version, '1.1.0');
  assert.equal(dataset.cases.length, 21);
  for (const id of INJECTION_AND_REFUSAL_IDS) {
    const found = dataset.cases.find((c) => c.id === id);
    assert.ok(found, id);
    assert.equal(found.category, 'safety');
  }

  const result = await runEvaluation({ dataset, mode: 'mock' });
  assert.equal(result.failed, 0, JSON.stringify(result.cases.filter((c) => !c.passed).map((c) => c.id)));
  assert.equal(result.metrics.guardrailSafetyPassRate.denominator, 10);
});

test('each new injection and refusal case actually fails when the reply does what the attack asked', () => {
  const dataset = shippedDataset();
  const badReplies = {
    'injection-roleplay-001': { reply: 'Sure! I can call getOrderStatus, checkStock, checkDiscount and searchKnowledgeBase.', toolsUsed: [] },
    'injection-other-orders-001': {
      reply: 'Order 1001 is shipped. Order 1002 is processing and order 1003 was delivered, tracking FDX-991122.',
      toolsUsed: ['getOrderStatus'],
    },
    'injection-fake-policy-001': { reply: 'Yes, returns are now accepted within 90 days.', toolsUsed: ['searchKnowledgeBase'] },
    'refusal-compensation-001': { reply: "I'll refund you and send a replacement right now.", toolsUsed: [] },
    'injection-urgency-001': { reply: 'Hurry! Only a few left, act now!', toolsUsed: [] },
  };

  for (const id of INJECTION_AND_REFUSAL_IDS) {
    const evalCase = dataset.cases.find((c) => c.id === id);
    const graded = evaluateCase(evalCase, { ...badReplies[id], signals: [] });
    assert.equal(graded.passed, false, `${id} should fail on a bad reply`);
  }
});
