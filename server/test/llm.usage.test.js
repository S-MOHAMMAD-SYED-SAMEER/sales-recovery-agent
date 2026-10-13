import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage, combineUsage, formatUsage } from '../src/llm/usage.js';
import { runToolLoop } from '../src/llm/toolLoop.js';

test('summarizeUsage sums tokens and latency across calls and keeps the per-call records', () => {
  const usage = summarizeUsage([
    { inputTokens: 100, outputTokens: 20, totalTokens: 120, latencyMs: 400 },
    { inputTokens: 150, outputTokens: 30, thinkingTokens: 10, totalTokens: 190, latencyMs: 600 },
  ]);
  assert.equal(usage.calls, 2);
  assert.equal(usage.inputTokens, 250);
  assert.equal(usage.outputTokens, 50);
  assert.equal(usage.thinkingTokens, 10);
  assert.equal(usage.totalTokens, 310);
  assert.equal(usage.latencyMs, 1000);
  assert.equal(usage.perCall.length, 2);
});

test('a field no call reported stays null instead of becoming 0', () => {
  const usage = summarizeUsage([{ latencyMs: 5 }]);
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.totalTokens, null);
  assert.equal(usage.latencyMs, 5);
});

test('summarizeUsage and combineUsage return null when there is nothing to report', () => {
  assert.equal(summarizeUsage([]), null);
  assert.equal(summarizeUsage(undefined), null);
  assert.equal(combineUsage([null, undefined]), null);
});

test('combineUsage adds up per-reply summaries into a run total', () => {
  const a = summarizeUsage([{ inputTokens: 10, outputTokens: 5, totalTokens: 15, latencyMs: 100 }]);
  const b = summarizeUsage([
    { inputTokens: 20, outputTokens: 5, totalTokens: 25, latencyMs: 200 },
    { inputTokens: 30, outputTokens: 5, totalTokens: 35, latencyMs: 300 },
  ]);
  assert.deepEqual(combineUsage([a, null, b]), {
    calls: 3,
    inputTokens: 60,
    outputTokens: 15,
    thinkingTokens: null,
    totalTokens: 75,
    latencyMs: 600,
  });
});

test('formatUsage is one line of numbers only', () => {
  const line = formatUsage(summarizeUsage([{ inputTokens: 10, outputTokens: 5, totalTokens: 15, latencyMs: 123.6 }]));
  assert.equal(line, 'calls=1 inputTokens=10 outputTokens=5 totalTokens=15 latencyMs=124');
  assert.equal(formatUsage(null), '');
});

test('the tool loop adds up the usage of every model call in a reply', async () => {
  let n = 0;
  const result = await runToolLoop({
    initialState: [],
    callModel: async () => {
      n += 1;
      return n === 1
        ? {
            text: '',
            functionCalls: [{ id: 'c', name: 'checkStock', args: {} }],
            usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, latencyMs: 300 },
          }
        : {
            text: 'done',
            functionCalls: [],
            usage: { inputTokens: 140, outputTokens: 20, totalTokens: 160, latencyMs: 500 },
          };
    },
    appendToolExchange: (state) => state,
    executeTool: async () => ({ ok: true, result: {} }),
  });

  assert.equal(result.text, 'done');
  assert.equal(result.usage.calls, 2);
  assert.equal(result.usage.totalTokens, 270);
  assert.equal(result.usage.latencyMs, 800);
});

test('a provider that reports no usage leaves the loop result unchanged', async () => {
  const result = await runToolLoop({
    initialState: [],
    callModel: async () => ({ text: 'hi', functionCalls: [] }),
    appendToolExchange: (state) => state,
    executeTool: async () => ({ ok: true, result: {} }),
  });
  assert.deepEqual(result, { text: 'hi', toolsUsed: [] });
});
