import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReply, isConfigured } from '../src/llm/providers/demo.js';
import { businessTools, createToolExecutor } from '../src/tools/index.js';

// A fake searchKnowledgeBase tool, shaped exactly like the real one
// (rag/searchKnowledgeBaseTool.js: name/description/parameters/execute,
// resolving to {found, ...}) — this is the same "fake vector store" strategy
// test/rag.retriever.test.js already uses, applied one layer up so these
// tests need no real Chroma server or embedding model.
function fakeKnowledgeBaseTool(execute) {
  return { name: 'searchKnowledgeBase', description: '', parameters: {}, execute };
}

function userMessage(text) {
  return [{ role: 'user', content: text }];
}

// Records every call made through it while still dispatching to the real
// tool logic beneath — lets a test assert *which* real tool ran without
// re-testing that tool's own business logic (already covered by
// test/tools.test.js and test/rag.searchKnowledgeBaseTool.test.js).
function spyExecuteTool(tools) {
  const dispatch = createToolExecutor(tools);
  const calls = [];
  return {
    calls,
    async execute(name, args) {
      calls.push({ name, args });
      return dispatch(name, args);
    },
  };
}

function realExecutor(kbExecute) {
  const tools = kbExecute ? [...businessTools, fakeKnowledgeBaseTool(kbExecute)] : businessTools;
  const spy = spyExecuteTool(tools);
  return { executeTool: spy.execute, calls: spy.calls };
}

// --- provider contract & credential-free -----------------------------------

test('demo provider requires no API key / credential of any kind', () => {
  assert.equal(isConfigured, true);
});

test('follows the same generateReply({systemPrompt, messages, tools, executeTool}) contract as the real providers', async () => {
  const { executeTool } = realExecutor();
  const result = await generateReply({
    systemPrompt: 'irrelevant to the demo provider',
    messages: userMessage('hello there'),
    tools: [],
    executeTool,
  });

  assert.equal(typeof result.text, 'string');
  assert.ok(Array.isArray(result.toolsUsed));
});

// --- 1. order status ---------------------------------------------------

test('a known order-status question produces a deterministic, tool-backed reply', async () => {
  const { executeTool, calls } = realExecutor();
  const result = await generateReply({ messages: userMessage("What's the status of order 1001?"), executeTool });

  assert.match(result.text, /shipped/i);
  assert.match(result.text, /DHL-778812/);
  assert.deepEqual(result.toolsUsed, ['getOrderStatus']);
  assert.deepEqual(calls, [{ name: 'getOrderStatus', args: { orderId: '1001' } }]);
});

test('an unknown order id is reported honestly, not fabricated', async () => {
  const { executeTool } = realExecutor();
  const result = await generateReply({ messages: userMessage("What's the status of order 9999?"), executeTool });

  assert.match(result.text, /couldn't find any order/i);
  assert.deepEqual(result.toolsUsed, ['getOrderStatus']);
});

// --- 2. stock -------------------------------------------------------------

test('a known in-stock product question produces a deterministic, tool-backed reply', async () => {
  const { executeTool, calls } = realExecutor();
  const result = await generateReply({ messages: userMessage('Is the Ceramic Mug in stock?'), executeTool });

  assert.match(result.text, /in stock/i);
  assert.match(result.text, /42/);
  assert.deepEqual(result.toolsUsed, ['checkStock']);
  assert.deepEqual(calls, [{ name: 'checkStock', args: { product: 'ceramic mug' } }]);
});

test('an out-of-stock product is reported honestly', async () => {
  const { executeTool } = realExecutor();
  const result = await generateReply({ messages: userMessage('Is the Linen Tote Bag available?'), executeTool });

  assert.match(result.text, /out of stock/i);
  assert.deepEqual(result.toolsUsed, ['checkStock']);
});

// --- 3. discount ------------------------------------------------------

test('a valid discount code produces a deterministic, tool-backed reply', async () => {
  const { executeTool, calls } = realExecutor();
  const result = await generateReply({ messages: userMessage('Is WELCOME10 still valid?'), executeTool });

  assert.match(result.text, /10% off/);
  assert.deepEqual(result.toolsUsed, ['checkDiscount']);
  assert.deepEqual(calls, [{ name: 'checkDiscount', args: { code: 'WELCOME10' } }]);
});

test('an expired discount code is reported as no longer active, not silently valid', async () => {
  const { executeTool } = realExecutor();
  const result = await generateReply({ messages: userMessage('Is EXPIRED5 valid?'), executeTool });

  assert.match(result.text, /no longer active/i);
  assert.doesNotMatch(result.text, /^Yes,/);
});

test('an unknown discount code is reported honestly', async () => {
  const { executeTool } = realExecutor();
  const result = await generateReply({ messages: userMessage('Is NOTREAL99 valid?'), executeTool });

  assert.match(result.text, /couldn't find a discount code/i);
});

// --- 4. policy / FAQ / RAG -------------------------------------------------

test('a policy question uses the real searchKnowledgeBase tool and relays its grounded text', async () => {
  const kb = async ({ query }) => {
    assert.match(query, /international shipping/i);
    return {
      found: true,
      results: [
        { source: 'shipping-policy.md', heading: 'International', text: 'International shipping typically takes 7-12 business days.', relevance: 0.91 },
      ],
    };
  };
  const { executeTool, calls } = realExecutor(kb);
  const result = await generateReply({ messages: userMessage('How long does international shipping take?'), executeTool });

  assert.equal(result.text, 'International shipping typically takes 7-12 business days.');
  assert.deepEqual(result.toolsUsed, ['searchKnowledgeBase']);
  assert.equal(calls[0].name, 'searchKnowledgeBase');
});

test('a policy question with no knowledge-base match is answered honestly, not invented', async () => {
  const kb = async () => ({ found: false, message: 'internal instruction text, never shown to a customer' });
  const { executeTool } = realExecutor(kb);
  const result = await generateReply({ messages: userMessage('What is your return policy?'), executeTool });

  assert.match(result.text, /don't have information/i);
  assert.doesNotMatch(result.text, /internal instruction/i);
});

test('a policy question degrades to an honest, temporary-unavailability message when the knowledge base cannot be reached', async () => {
  // Simulates the real searchKnowledgeBase tool's documented degraded-mode
  // contract (rag/searchKnowledgeBaseTool.js) when Chroma is unreachable —
  // exactly the state of this environment, which has no Chroma server
  // running. See this file's header comment and the final report for why
  // this is simulated rather than exercised against a real, absent Chroma.
  const kb = async () => ({ found: false, unavailable: true, message: 'internal instruction text, never shown to a customer' });
  const { executeTool } = realExecutor(kb);
  const result = await generateReply({ messages: userMessage('What is your return policy?'), executeTool });

  assert.match(result.text, /couldn't access that store information/i);
  assert.doesNotMatch(result.text, /internal instruction/i);
});

// --- 5. guardrail-triggering scenario ---------------------------------

test('a damaged-item refund request produces an unsupported refund promise, for the real guardrail pipeline to catch', async () => {
  const { executeTool } = realExecutor();
  const result = await generateReply({ messages: userMessage('My order arrived damaged, can you refund me?'), executeTool });

  // Deliberately left unsafe here — see the provider's own comment. This
  // exact phrase must match guardrails/policies.js's REFUND_PROMISE_RE;
  // proven end-to-end (through the real guardrail) in
  // test/chat.demoProvider.integration.test.js.
  assert.match(result.text, /i'll refund you/i);
  assert.deepEqual(result.toolsUsed, []);
});

// --- 6. escalation / recovery (hesitation) ---------------------------------

test('a purchase-hesitation message gets a reassuring, non-fabricating reply with no tool call', async () => {
  const { executeTool, calls } = realExecutor();
  const result = await generateReply({
    messages: userMessage("I like this but I'm still deciding if I need it."),
    executeTool,
  });

  assert.match(result.text, /happy to check/i);
  assert.deepEqual(result.toolsUsed, []);
  assert.deepEqual(calls, []);
});

// --- unsupported input ------------------------------------------------

test('an unsupported question returns the fixed fallback, not a fabricated answer', async () => {
  const { executeTool, calls } = realExecutor();
  const result = await generateReply({ messages: userMessage('What is the meaning of life?'), executeTool });

  assert.equal(
    result.text,
    'This portfolio demo supports a fixed set of example customer-support scenarios. ' +
      'Please choose one of the suggested questions.'
  );
  assert.deepEqual(result.toolsUsed, []);
  assert.deepEqual(calls, []);
});

// --- regression: B1, discount-code matching hijacking stock/order input ---
//
// The discount-code shape (letters immediately followed by digits) also
// matches a bare SKU ("MUG001") and an alphanumeric order reference
// ("abc123") — a message must also name the topic (discount/coupon/promo/
// code/valid) before that shape is treated as a discount lookup at all.

test('B1: a SKU-style stock question is not hijacked into a discount lookup', async () => {
  const { executeTool, calls } = realExecutor();
  const result = await generateReply({ messages: userMessage('Do you have MUG001 in stock?'), executeTool });

  assert.deepEqual(result.toolsUsed, ['checkStock']);
  assert.match(result.text, /in stock/i);
  assert.deepEqual(calls, [{ name: 'checkStock', args: { product: 'mug' } }]);
});

test('B1: an alphanumeric order reference routes to order status, not discount', async () => {
  const { executeTool, calls } = realExecutor();
  const result = await generateReply({ messages: userMessage('Can you track order abc123?'), executeTool });

  assert.deepEqual(result.toolsUsed, ['getOrderStatus']);
  assert.match(result.text, /couldn't find any order/i);
  assert.deepEqual(calls, [{ name: 'getOrderStatus', args: { orderId: 'abc123' } }]);
});

test('B1: a genuine discount-code question still routes to the discount tool', async () => {
  const { executeTool, calls } = realExecutor();
  const result = await generateReply({ messages: userMessage('Is WELCOME10 still valid?'), executeTool });

  assert.deepEqual(result.toolsUsed, ['checkDiscount']);
  assert.match(result.text, /10% off/);
  assert.deepEqual(calls, [{ name: 'checkDiscount', args: { code: 'WELCOME10' } }]);
});

test('B1: a letters-then-digits word with no discount/order/stock context is not a discount lookup', async () => {
  const { executeTool, calls } = realExecutor();
  const result = await generateReply({
    messages: userMessage('I ordered on day3 of the sale, any updates?'),
    executeTool,
  });

  assert.notDeepEqual(result.toolsUsed, ['checkDiscount']);
  assert.doesNotMatch(result.text, /discount code called/i);
  assert.deepEqual(calls, []);
});

test('B1: asking about an order with no id-shaped token falls back, rather than guessing an order id', async () => {
  const { executeTool, calls } = realExecutor();
  const result = await generateReply({ messages: userMessage('Where is my order please?'), executeTool });

  assert.deepEqual(result.toolsUsed, []);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(result.text, /couldn't find any order with the id please/i);
});

test('B1: an "ORD-" prefixed order reference still resolves via the real tool\'s own normalization', async () => {
  const { executeTool } = realExecutor();
  const result = await generateReply({ messages: userMessage("What's the status of order ORD-1002?"), executeTool });

  assert.deepEqual(result.toolsUsed, ['getOrderStatus']);
  assert.match(result.text, /processing/i);
});

// --- determinism --------------------------------------------------------

test('the same input produces byte-identical output every time', async () => {
  const first = await generateReply({ messages: userMessage('Is the Ceramic Mug in stock?'), executeTool: realExecutor().executeTool });
  const second = await generateReply({ messages: userMessage('Is the Ceramic Mug in stock?'), executeTool: realExecutor().executeTool });

  assert.deepEqual(first, second);
});

test('the same unsupported input produces byte-identical fallback output every time', async () => {
  const { executeTool } = realExecutor();
  const first = await generateReply({ messages: userMessage('Tell me a joke.'), executeTool });
  const second = await generateReply({ messages: userMessage('Tell me a joke.'), executeTool });

  assert.deepEqual(first, second);
});
