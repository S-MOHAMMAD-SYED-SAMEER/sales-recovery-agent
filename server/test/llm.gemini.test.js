import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiProvider, checkResponse } from '../src/llm/providers/gemini.js';
import { LlmResponseError } from '../src/llm/resilience.js';

// A fake Gemini client: `responses` is a queue of results or errors, one per
// generateContent call, and every request is recorded. No network, no key.
function fakeClient(responses) {
  const requests = [];
  const queue = [...responses];
  return {
    requests,
    models: {
      async generateContent(request) {
        requests.push(request);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        if (typeof next === 'function') return next(request);
        return next;
      },
    },
  };
}

const textResponse = (text, extra = {}) => ({
  text,
  functionCalls: undefined,
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  ...extra,
});

const callResponse = (name, args) => ({
  text: undefined,
  functionCalls: [{ name, args }],
  candidates: [
    {
      content: { role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: 'sig-123' }] },
      finishReason: 'STOP',
    },
  ],
});

const httpError = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

const silent = { warn() {}, error() {}, log() {} };

function provider(client, overrides = {}) {
  const sleeps = [];
  const instance = createGeminiProvider({
    client,
    model: 'gemini-test-model',
    timeoutMs: 5_000,
    maxRetries: 2,
    maxOutputTokens: 777,
    temperature: 0.4,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    log: silent,
    ...overrides,
  });
  return { ...instance, sleeps };
}

const userTurn = [{ role: 'user', content: 'hello' }];
const noTools = async () => ({ ok: true, result: {} });

test('sends the configured model, token cap, temperature, system prompt and an abort signal', async () => {
  const client = fakeClient([textResponse('hi there')]);
  const { generateReply } = provider(client);

  const result = await generateReply({ systemPrompt: 'be brief', messages: userTurn, executeTool: noTools });

  assert.equal(result.text, 'hi there');
  const [request] = client.requests;
  assert.equal(request.model, 'gemini-test-model');
  assert.equal(request.config.maxOutputTokens, 777);
  assert.equal(request.config.temperature, 0.4);
  assert.equal(request.config.systemInstruction, 'be brief');
  assert.ok(request.config.abortSignal instanceof AbortSignal);
  assert.deepEqual(request.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
});

test('a request that never answers is aborted by the timeout, then retried and finally failed', async () => {
  // A request that never settles by itself. AbortSignal.timeout's timer does not
  // keep the process alive, so on some Node versions the event loop would exit
  // with this promise pending; a keep-alive interval stands in for the open
  // socket a real hung request would have.
  const hang = (request) =>
    new Promise((resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1000);
      request.config.abortSignal.addEventListener('abort', () => {
        clearInterval(keepAlive);
        reject(request.config.abortSignal.reason);
      });
    });
  const client = fakeClient([hang, hang]);
  const { generateReply, sleeps } = provider(client, { timeoutMs: 15, maxRetries: 1 });

  await assert.rejects(generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }), (err) => {
    assert.equal(err.name, 'TimeoutError');
    return true;
  });
  assert.equal(client.requests.length, 2);
  assert.equal(sleeps.length, 1);
});

test('a 429 is retried with backoff and then succeeds', async () => {
  const client = fakeClient([httpError(429), httpError(503), textResponse('finally')]);
  const { generateReply, sleeps } = provider(client);

  const result = await generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools });

  assert.equal(result.text, 'finally');
  assert.equal(client.requests.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('a 429 that names its own retry delay waits exactly that long', async () => {
  const client = fakeClient([
    httpError(429, { message: '{"error":{"details":[{"retryDelay":"7s"}]}}' }),
    textResponse('ok'),
  ]);
  const { generateReply, sleeps } = provider(client);

  await generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools });
  assert.deepEqual(sleeps, [7000]);
});

test('a 429 that asks for a long wait fails straight away instead of holding the customer', async () => {
  const client = fakeClient([httpError(429, { message: 'retry in 90s' }), textResponse('never reached')]);
  const { generateReply, sleeps } = provider(client);

  await assert.rejects(generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }), /retry in 90s/);
  assert.equal(client.requests.length, 1);
  assert.deepEqual(sleeps, []);
});

test('retries are bounded: the last error is thrown after maxRetries', async () => {
  const client = fakeClient([httpError(503), httpError(503), httpError(503), textResponse('unused')]);
  const { generateReply } = provider(client, { maxRetries: 2 });

  await assert.rejects(generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }), /HTTP 503/);
  assert.equal(client.requests.length, 3);
});

test('a bad request or a bad key is not retried', async () => {
  for (const status of [400, 401, 403]) {
    const client = fakeClient([httpError(status), textResponse('unused')]);
    const { generateReply } = provider(client);
    await assert.rejects(generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }));
    assert.equal(client.requests.length, 1, String(status));
  }
});

test('a prompt blocked by the safety filter is an error and is not retried', async () => {
  const blocked = { text: undefined, candidates: undefined, promptFeedback: { blockReason: 'SAFETY' } };
  const client = fakeClient([blocked, textResponse('unused')]);
  const { generateReply } = provider(client);

  await assert.rejects(generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }), (err) => {
    assert.ok(err instanceof LlmResponseError);
    assert.match(err.message, /blocked the prompt \(SAFETY\)/);
    return true;
  });
  assert.equal(client.requests.length, 1);
});

test('a reply with no text and a SAFETY finish reason is an error and is not retried', async () => {
  const empty = { text: undefined, candidates: [{ finishReason: 'SAFETY' }] };
  const client = fakeClient([empty, textResponse('unused')]);
  const { generateReply } = provider(client);

  await assert.rejects(generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }), /finishReason SAFETY/);
  assert.equal(client.requests.length, 1);
});

test('running out of output tokens before any text is an error that says how to fix it', async () => {
  const empty = { text: undefined, candidates: [{ finishReason: 'MAX_TOKENS' }] };
  const client = fakeClient([empty, textResponse('unused')]);
  const { generateReply } = provider(client);

  await assert.rejects(
    generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }),
    /LLM_MAX_OUTPUT_TOKENS/
  );
  assert.equal(client.requests.length, 1);
});

test('a flaky empty reply (finishReason STOP, no text) is retried once and recovers', async () => {
  const empty = { text: '', candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] };
  const client = fakeClient([empty, textResponse('second try works')]);
  const { generateReply } = provider(client);

  const result = await generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools });
  assert.equal(result.text, 'second try works');
  assert.equal(client.requests.length, 2);
});

test('a response with no candidates is retried', async () => {
  const client = fakeClient([{ text: undefined, candidates: [] }, textResponse('recovered')]);
  const { generateReply } = provider(client);

  const result = await generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools });
  assert.equal(result.text, 'recovered');
});

test('a reply cut off at the token limit but with text is returned, with a warning', () => {
  const warnings = [];
  const response = textResponse('half a sent', {
    candidates: [{ content: { parts: [{ text: 'half a sent' }] }, finishReason: 'MAX_TOKENS' }],
  });
  const finishReason = checkResponse(response, [], { warn: (m) => warnings.push(m) });
  assert.equal(finishReason, 'MAX_TOKENS');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cut off/);
});

test('a turn that only asks for a tool has no text and is not an error', () => {
  const response = callResponse('checkStock', { product: 'mug' });
  assert.doesNotThrow(() => checkResponse(response, response.functionCalls));
});

test('the tool loop still works through the adapter: the model turn is echoed back verbatim with the tool result', async () => {
  const client = fakeClient([callResponse('checkStock', { product: 'mug' }), textResponse('42 in stock')]);
  const { generateReply } = provider(client);
  const executed = [];

  const result = await generateReply({
    systemPrompt: 's',
    messages: userTurn,
    tools: [{ name: 'checkStock', description: 'd', parameters: { type: 'object', properties: {} } }],
    executeTool: async (name, args) => {
      executed.push([name, args]);
      return { ok: true, result: { quantity: 42 } };
    },
  });

  assert.equal(result.text, '42 in stock');
  assert.deepEqual(result.toolsUsed, ['checkStock']);
  assert.deepEqual(executed, [['checkStock', { product: 'mug' }]]);

  const secondRequest = client.requests[1];
  assert.equal(secondRequest.contents.length, 3);
  // Verbatim, including the thought signature the API insists on.
  assert.equal(secondRequest.contents[1].parts[0].thoughtSignature, 'sig-123');
  assert.deepEqual(secondRequest.contents[2], {
    role: 'user',
    parts: [{ functionResponse: { name: 'checkStock', response: { quantity: 42 } } }],
  });
  // The tools are declared on both requests.
  assert.ok(client.requests.every((r) => r.config.tools?.[0].functionDeclarations.length === 1));
});

test('without a client the adapter says the key is missing', async () => {
  const { generateReply } = provider(null);
  await assert.rejects(
    generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools }),
    /GEMINI_API_KEY is not set/
  );
});

test('records tokens, latency and attempts for each model call', async () => {
  const ticks = [1000, 1450];
  const response = textResponse('hi', {
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 15, thoughtsTokenCount: 40, totalTokenCount: 175 },
  });
  const client = fakeClient([httpError(503), response]);
  const { generateReply } = provider(client, { clock: () => ticks.shift() });

  const result = await generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools });

  assert.equal(result.usage.calls, 1);
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.outputTokens, 15);
  assert.equal(result.usage.thinkingTokens, 40);
  assert.equal(result.usage.totalTokens, 175);
  assert.equal(result.usage.latencyMs, 450);
  assert.equal(result.usage.perCall[0].attempts, 2);
  assert.equal(result.usage.perCall[0].model, 'gemini-test-model');
  assert.equal(result.usage.perCall[0].finishReason, 'STOP');
});

test('a response with no usage metadata still returns, with null token counts', async () => {
  const client = fakeClient([textResponse('hi')]);
  const { generateReply } = provider(client);
  const result = await generateReply({ systemPrompt: 's', messages: userTurn, executeTool: noTools });
  assert.equal(result.text, 'hi');
  assert.equal(result.usage.inputTokens, null);
});
