import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnthropicClient,
  createAnthropicProvider,
  checkResponse,
} from '../src/llm/providers/anthropic.js';
import { LlmResponseError } from '../src/llm/resilience.js';

function fakeClient(responses) {
  const requests = [];
  const queue = [...responses];
  return {
    requests,
    messages: {
      async create(request) {
        requests.push(structuredClone(request));
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

const textMessage = (text, stopReason = 'end_turn') => ({
  content: [{ type: 'text', text }],
  stop_reason: stopReason,
});

const toolMessage = (name, input) => ({
  content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
  stop_reason: 'tool_use',
});

const silent = { warn() {} };
const userTurn = [{ role: 'user', content: 'hello' }];
const noTools = async () => ({ ok: true, result: {} });

function provider(client, overrides = {}) {
  return createAnthropicProvider({
    client,
    model: 'claude-test-model',
    maxOutputTokens: 640,
    temperature: 0.3,
    log: silent,
    ...overrides,
  });
}

test('the client is built with an explicit timeout and a bounded retry count', () => {
  const client = buildAnthropicClient({ apiKey: 'test-key-not-real', timeoutMs: 12_345, maxRetries: 4 });
  assert.equal(client.timeout, 12_345);
  assert.equal(client.maxRetries, 4);
});

test('the model, token cap and temperature come from settings, not from the adapter', async () => {
  const client = fakeClient([textMessage('hi')]);
  const { generateReply } = provider(client);

  const result = await generateReply({ systemPrompt: 'be brief', messages: userTurn, executeTool: noTools });

  assert.equal(result.text, 'hi');
  const [request] = client.requests;
  assert.equal(request.model, 'claude-test-model');
  assert.equal(request.max_tokens, 640);
  assert.equal(request.temperature, 0.3);
  assert.equal(request.system, 'be brief');
  assert.equal(request.tools, undefined);
});

test('a refusal is an error, not an empty reply', async () => {
  const client = fakeClient([{ content: [], stop_reason: 'refusal' }]);
  const { generateReply } = provider(client);

  await assert.rejects(generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }), (err) => {
    assert.ok(err instanceof LlmResponseError);
    assert.match(err.message, /refusal/);
    return true;
  });
});

test('a response with no text and no tool call is an error', async () => {
  const client = fakeClient([{ content: [], stop_reason: 'end_turn' }]);
  const { generateReply } = provider(client);

  await assert.rejects(generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }), /no text/);
});

test('whitespace-only text counts as no text', async () => {
  const client = fakeClient([textMessage('  \n')]);
  const { generateReply } = provider(client);

  await assert.rejects(generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }), /no text/);
});

test('a reply cut off at the token limit but with text is returned, with a warning', () => {
  const warnings = [];
  checkResponse(textMessage('half a sent', 'max_tokens'), 'half a sent', [], { warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cut off/);
});

test('the tool loop works through the adapter and sends the tool result back', async () => {
  const client = fakeClient([toolMessage('checkStock', { product: 'mug' }), textMessage('42 in stock')]);
  const { generateReply } = provider(client);

  const result = await generateReply({
    systemPrompt: 's',
    messages: userTurn,
    tools: [{ name: 'checkStock', description: 'd', parameters: { type: 'object', properties: {} } }],
    executeTool: async () => ({ ok: true, result: { quantity: 42 } }),
  });

  assert.equal(result.text, '42 in stock');
  assert.deepEqual(result.toolsUsed, ['checkStock']);

  const second = client.requests[1];
  assert.equal(second.messages.length, 3);
  assert.equal(second.messages[1].role, 'assistant');
  assert.deepEqual(second.messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    content: JSON.stringify({ quantity: 42 }),
    is_error: false,
  });
  assert.equal(second.tools[0].name, 'checkStock');
});

test('an error from the client propagates (the SDK has already retried it)', async () => {
  const client = fakeClient([Object.assign(new Error('overloaded'), { status: 529 })]);
  const { generateReply } = provider(client);

  await assert.rejects(generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }), /overloaded/);
  assert.equal(client.requests.length, 1);
});

test('without a client the adapter says the key is missing', async () => {
  const { generateReply } = provider(null);
  await assert.rejects(
    generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }),
    /ANTHROPIC_API_KEY is not set/
  );
});
