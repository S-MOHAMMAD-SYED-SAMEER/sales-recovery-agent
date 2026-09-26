// Application-level integration: LLM_PROVIDER=demo driving the *real*
// handleChat pipeline (memory -> signals -> generateReply -> guardrails ->
// persistence), with no generateReply stub injected — unlike
// test/chat.route.test.js's stubs, this exercises the real
// llm/index.js -> providers/demo.js path exactly as a live request would.
//
// config/env.js reads process.env once at module load (see
// test/config.test.js), so LLM_PROVIDER is set — and any real credential
// removed — before anything is imported, via dynamic import() rather than a
// static import (which ESM would hoist above these assignments). Node's test
// runner gives each test file its own process by default, so this can't
// affect config as seen by any other test file.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_PROVIDER = 'demo';
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { isConfigured } = await import('../src/config/env.js');
const { handleChat } = await import('../src/routes/chat.js');
const { createDb } = await import('../src/memory/db.js');
const { createConversationStore } = await import('../src/memory/conversationStore.js');

function freshStore() {
  return createConversationStore(createDb(':memory:'));
}

test('LLM_PROVIDER=demo is configured with no Gemini or Anthropic credential present', () => {
  assert.equal(isConfigured, true);
});

test('POST /api/chat succeeds end-to-end under LLM_PROVIDER=demo, with no credential stub injected', async () => {
  const store = freshStore();
  const result = await handleChat({ sessionId: 's1', message: 'Is the Ceramic Mug in stock?' }, { conversationStore: store });

  assert.equal(result.status, 200);
  assert.match(result.body.reply, /in stock/i);
  assert.deepEqual(result.body.toolsUsed, ['checkStock']);
});

test('a hesitation message survives the real handleChat -> guardrails pipeline with the expected recovery reply, and persists that same content', async () => {
  const store = freshStore();
  const result = await handleChat(
    { sessionId: 's1', message: "I like this but I'm still deciding if I need it." },
    { conversationStore: store }
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.signals.length, 1);
  assert.equal(result.body.signals[0].type, 'purchase_hesitation');

  // The demo provider's own scripted hesitation/recovery reply
  // (providers/demo.js's respondHesitation()) is part of the deterministic
  // demo contract — asserted directly here, not merely implied by comparing
  // the response to itself, so a regression that let a guardrail start
  // blocking it (silently replacing it with the generic SAFE_FALLBACK_REPLY)
  // would fail this test instead of passing it.
  assert.match(result.body.reply, /happy to check stock/i);
  assert.doesNotMatch(result.body.reply, /connect you with our support team/i);

  // Persistence checked against that same expected content — not against
  // result.body.reply — so this would also catch a guardrail-blocked reply
  // being the thing that got saved to memory.
  const history = store.getHistory('s1');
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], { role: 'user', content: "I like this but I'm still deciding if I need it." });
  assert.equal(history[1].role, 'assistant');
  assert.match(history[1].content, /happy to check stock/i);
  assert.doesNotMatch(history[1].content, /connect you with our support team/i);
});

test('guardrails still intercept the demo provider exactly as they would a real model', async () => {
  const store = freshStore();
  const result = await handleChat(
    { sessionId: 's1', message: 'My order arrived damaged, can you refund me?' },
    { conversationStore: store }
  );

  assert.equal(result.status, 200);
  // The demo provider's own scripted text for this scenario is an unsupported
  // refund promise (see providers/demo.js) — this proves the real guardrail
  // pipeline (guardrails/index.js), not the provider, is what stops it.
  assert.match(result.body.reply, /connect you with our support team/i);
  assert.doesNotMatch(result.body.reply, /i'll refund you/i);
});

test('a guardrail-blocked demo-provider reply persists only the safe fallback to memory', async () => {
  const store = freshStore();
  await handleChat(
    { sessionId: 's1', message: 'My order arrived damaged, can you refund me?' },
    { conversationStore: store }
  );

  const history = store.getHistory('s1');
  assert.equal(history[1].role, 'assistant');
  assert.doesNotMatch(history[1].content, /i'll refund you/i);
  assert.match(history[1].content, /connect you with our support team/i);
});

test('an unsupported question under the demo provider still returns 200 with the fixed fallback, never a 500', async () => {
  const store = freshStore();
  const result = await handleChat({ sessionId: 's1', message: 'What is the meaning of life?' }, { conversationStore: store });

  assert.equal(result.status, 200);
  assert.match(result.body.reply, /fixed set of example customer-support scenarios/i);
});
