import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../src/llm/toolLoop.js';

test('returns immediately when the model needs no tool', async () => {
  let executeCalls = 0;
  const result = await runToolLoop({
    initialState: ['turn0'],
    callModel: async () => ({ text: 'Hello!', functionCalls: [] }),
    appendToolExchange: () => {
      throw new Error('should not be called');
    },
    executeTool: async () => {
      executeCalls += 1;
      return { ok: true, result: {} };
    },
  });

  assert.deepEqual(result, { text: 'Hello!', toolsUsed: [] });
  assert.equal(executeCalls, 0);
});

test('executes a requested tool, appends the exchange, and returns the final text', async () => {
  let modelCallCount = 0;
  const executeArgsSeen = [];
  const appendCalls = [];

  const result = await runToolLoop({
    initialState: [],
    callModel: async (state) => {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return { text: '', functionCalls: [{ id: 'call-1', name: 'getOrderStatus', args: { orderId: '1001' } }] };
      }
      return { text: 'Your order has shipped.', functionCalls: [] };
    },
    appendToolExchange: (state, modelResult, outcomes) => {
      appendCalls.push(outcomes);
      return [...state, 'tool-exchange'];
    },
    executeTool: async (name, args) => {
      executeArgsSeen.push({ name, args });
      return { ok: true, result: { found: true, status: 'shipped' } };
    },
  });

  assert.deepEqual(result, { text: 'Your order has shipped.', toolsUsed: ['getOrderStatus'] });
  assert.deepEqual(executeArgsSeen, [{ name: 'getOrderStatus', args: { orderId: '1001' } }]);
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0][0].call.name, 'getOrderStatus');
  assert.equal(appendCalls[0][0].outcome.result.status, 'shipped');
});

test('accumulates toolsUsed across multiple tool-call rounds', async () => {
  let modelCallCount = 0;

  const result = await runToolLoop({
    initialState: [],
    callModel: async () => {
      modelCallCount += 1;
      if (modelCallCount === 1) return { text: '', functionCalls: [{ name: 'checkStock', args: { product: 'Mug' } }] };
      if (modelCallCount === 2) return { text: '', functionCalls: [{ name: 'checkDiscount', args: { code: 'WELCOME10' } }] };
      return { text: 'It is in stock and the code is valid.', functionCalls: [] };
    },
    appendToolExchange: (state) => [...state, 'x'],
    executeTool: async () => ({ ok: true, result: {} }),
  });

  assert.deepEqual(result.toolsUsed, ['checkStock', 'checkDiscount']);
  assert.equal(result.text, 'It is in stock and the code is valid.');
});

test('a failed tool outcome does not crash the loop and is still reported in toolsUsed', async () => {
  let modelCallCount = 0;
  let seenOutcome;

  const result = await runToolLoop({
    initialState: [],
    callModel: async () => {
      modelCallCount += 1;
      if (modelCallCount === 1) return { text: '', functionCalls: [{ name: 'getOrderStatus', args: {} }] };
      return { text: 'Sorry, I could not look that up.', functionCalls: [] };
    },
    appendToolExchange: (state, modelResult, outcomes) => {
      seenOutcome = outcomes[0].outcome;
      return [...state, 'x'];
    },
    executeTool: async () => ({ ok: false, error: 'Invalid arguments for getOrderStatus: orderId is required.' }),
  });

  assert.deepEqual(result.toolsUsed, ['getOrderStatus']);
  assert.equal(seenOutcome.ok, false);
  assert.equal(result.text, 'Sorry, I could not look that up.');
});

test('throws a clear error when the model keeps requesting tools past the iteration cap', async () => {
  await assert.rejects(
    () =>
      runToolLoop({
        initialState: [],
        maxIterations: 2,
        callModel: async () => ({ text: '', functionCalls: [{ name: 'getOrderStatus', args: { orderId: '1001' } }] }),
        appendToolExchange: (state) => [...state, 'x'],
        executeTool: async () => ({ ok: true, result: {} }),
      }),
    /Exceeded maximum tool-call iterations/
  );
});
