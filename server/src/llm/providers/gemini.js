import { GoogleGenAI } from '@google/genai';
import { config } from '../../config/env.js';
import { runToolLoop } from '../toolLoop.js';
import { LlmResponseError, withRetry } from '../resilience.js';

const client = config.geminiApiKey ? new GoogleGenAI({ apiKey: config.geminiApiKey }) : null;

export const isConfigured = Boolean(client);

// Gemini 3.x is documented to behave best at its default temperature of 1.0, so
// that is the explicit default here rather than a lower "more deterministic"
// value. LLM_TEMPERATURE overrides it. Worth re-checking against the live API.
const DEFAULT_TEMPERATURE = 1.0;

// A finish reason that means the content itself was refused. Asking again would
// get the same answer, so these are not retried.
const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'LANGUAGE',
]);

// Gemini uses role "model" for assistant turns, not "assistant".
export function toGeminiRole(role) {
  return role === 'assistant' ? 'model' : 'user';
}

export function toGeminiTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    },
  ];
}

// Prefer the SDK's response.functionCalls convenience getter; fall back to
// reading the raw candidate parts in case a given SDK version doesn't expose it.
export function extractFunctionCalls(response) {
  if (Array.isArray(response.functionCalls)) return response.functionCalls;
  const parts = response.candidates?.[0]?.content?.parts || [];
  return parts.filter((part) => part.functionCall).map((part) => part.functionCall);
}

// Turns a response that arrived but has nothing usable in it into an error the
// caller can see, instead of an `undefined` reply travelling up the stack.
// A turn that asks for tools legitimately has no text; every other turn needs
// some. Returns the finish reason for logging.
export function checkResponse(response, functionCalls, { warn = console.warn } = {}) {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new LlmResponseError(`Gemini blocked the prompt (${blockReason}).`, { finishReason: blockReason });
  }

  const finishReason = response.candidates?.[0]?.finishReason;
  if (functionCalls.length > 0) return finishReason;

  if (!response.candidates || response.candidates.length === 0) {
    throw new LlmResponseError('Gemini returned no candidates.', { retryable: true });
  }

  const text = response.text;
  if (typeof text === 'string' && text.trim()) {
    if (finishReason === 'MAX_TOKENS') {
      warn('[llm] Gemini reply was cut off at the output-token limit (LLM_MAX_OUTPUT_TOKENS).');
    }
    return finishReason;
  }

  if (BLOCKED_FINISH_REASONS.has(finishReason)) {
    throw new LlmResponseError(`Gemini returned no text (finishReason ${finishReason}).`, { finishReason });
  }
  if (finishReason === 'MAX_TOKENS') {
    // Often a thinking model spending the whole budget on reasoning. The same
    // request would do it again, so say how to fix it instead of retrying.
    throw new LlmResponseError(
      'Gemini hit the output-token limit before writing any text (raise LLM_MAX_OUTPUT_TOKENS).',
      { finishReason }
    );
  }
  // STOP, OTHER, MALFORMED_FUNCTION_CALL, or no reason: a flaky empty turn that
  // a second attempt can reasonably fix.
  throw new LlmResponseError(`Gemini returned an empty reply (finishReason ${finishReason ?? 'none'}).`, {
    retryable: true,
    finishReason,
  });
}

// Built from explicit settings and an injectable client so the retry, timeout
// and response-handling behaviour can be tested against a fake client with a
// fake clock; the module-level `generateReply` below is this, wired to config.
export function createGeminiProvider({
  client: geminiClient,
  model,
  timeoutMs,
  maxRetries,
  maxOutputTokens,
  temperature = DEFAULT_TEMPERATURE,
  sleep,
  random,
  log = console,
}) {
  async function generateReply({ systemPrompt, messages, tools = [], executeTool }) {
    if (!geminiClient) {
      throw new Error('Gemini provider selected but GEMINI_API_KEY is not set.');
    }

    const geminiTools = toGeminiTools(tools);
    const initialState = messages.map((m) => ({
      role: toGeminiRole(m.role),
      parts: [{ text: m.content }],
    }));

    const callModel = async (contents) => {
      const response = await withRetry(
        async () => {
          const result = await geminiClient.models.generateContent({
            model,
            config: {
              systemInstruction: systemPrompt,
              ...(geminiTools ? { tools: geminiTools } : {}),
              maxOutputTokens,
              temperature,
              // Per attempt: a hung request is cut off, then retried or failed.
              abortSignal: AbortSignal.timeout(timeoutMs),
            },
            contents,
          });
          const functionCalls = extractFunctionCalls(result);
          checkResponse(result, functionCalls, { warn: (m) => log.warn(m) });
          return { result, functionCalls };
        },
        {
          maxRetries,
          sleep,
          random,
          onRetry: ({ attempt, delayMs, error }) =>
            log.warn(`[llm] Gemini call failed (${error.message}); retry ${attempt} in ${Math.round(delayMs)}ms.`),
        }
      );
      const { result: finalResponse, functionCalls } = response;

      return {
        text: finalResponse.text,
        functionCalls,
        // The model's own turn, verbatim. Gemini 3.x attaches an internal
        // thought_signature to functionCall parts that MUST be echoed back
        // unchanged on the next turn — reconstructing the part by hand from
        // just {name, args} drops that signature and the API rejects the
        // follow-up call. See https://ai.google.dev/gemini-api/docs/thinking#signatures.
        modelContent: finalResponse.candidates?.[0]?.content,
      };
    };

    const appendToolExchange = (contents, modelResult, outcomes) => [
      ...contents,
      modelResult.modelContent,
      {
        role: 'user',
        parts: outcomes.map(({ call, outcome }) => ({
          functionResponse: {
            name: call.name,
            response: outcome.ok ? outcome.result : { error: outcome.error },
          },
        })),
      },
    ];

    return runToolLoop({ initialState, callModel, appendToolExchange, executeTool });
  }

  return { generateReply };
}

export const { generateReply } = createGeminiProvider({
  client,
  model: config.geminiModel,
  timeoutMs: config.llmTimeoutMs,
  maxRetries: config.llmMaxRetries,
  maxOutputTokens: config.llmMaxOutputTokens,
  temperature: config.llmTemperature ?? DEFAULT_TEMPERATURE,
});
