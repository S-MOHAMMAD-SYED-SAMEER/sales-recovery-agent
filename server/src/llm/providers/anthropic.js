import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/env.js';
import { runToolLoop } from '../toolLoop.js';
import { LlmResponseError } from '../resilience.js';

// The Anthropic SDK already retries a 429, a 5xx or a dropped connection with
// backoff, and waits for the server's Retry-After header. So retries and the
// per-attempt timeout are handed to the SDK here instead of being wrapped a
// second time (which would multiply the attempts).
export function buildAnthropicClient({ apiKey, timeoutMs, maxRetries }) {
  return new Anthropic({ apiKey, timeout: timeoutMs, maxRetries });
}

const client = config.anthropicApiKey
  ? buildAnthropicClient({
      apiKey: config.anthropicApiKey,
      timeoutMs: config.llmTimeoutMs,
      maxRetries: config.llmMaxRetries,
    })
  : null;

// Lower than the API default of 1.0: a support answer should vary less between
// runs. LLM_TEMPERATURE overrides it.
const DEFAULT_TEMPERATURE = 0.2;

export function toAnthropicTools(tools) {
  return (tools || []).map(({ name, description, parameters }) => ({
    name,
    description,
    input_schema: parameters,
  }));
}

// A response that has nothing a customer could be shown: a refusal, or no text
// and no tool call. Throws instead of letting an empty string travel upward.
export function checkResponse(response, text, functionCalls, { warn = console.warn } = {}) {
  if (functionCalls.length > 0) return;

  if (response.stop_reason === 'refusal') {
    throw new LlmResponseError('Claude declined to answer (stop_reason refusal).', {
      finishReason: 'refusal',
    });
  }
  if (!text.trim()) {
    throw new LlmResponseError(
      `Claude returned no text (stop_reason ${response.stop_reason ?? 'none'}).`,
      { finishReason: response.stop_reason }
    );
  }
  if (response.stop_reason === 'max_tokens') {
    warn('[llm] Claude reply was cut off at the output-token limit (LLM_MAX_OUTPUT_TOKENS).');
  }
}

// Built from explicit settings and an injectable client so request parameters
// and response handling can be tested against a fake client; the module-level
// `generateReply` below is this, wired to config.
export function createAnthropicProvider({
  client: anthropicClient,
  model,
  maxOutputTokens,
  temperature = DEFAULT_TEMPERATURE,
  clock = () => performance.now(),
  log = console,
}) {
  async function generateReply({ systemPrompt, messages, tools = [], executeTool }) {
    if (!anthropicClient) {
      throw new Error('Anthropic provider selected but ANTHROPIC_API_KEY is not set.');
    }

    const anthropicTools = toAnthropicTools(tools);
    const initialState = messages.map((m) => ({ role: m.role, content: m.content }));

    const callModel = async (conversation) => {
      const startedAt = clock();
      const response = await anthropicClient.messages.create({
        model,
        max_tokens: maxOutputTokens,
        temperature,
        system: systemPrompt,
        messages: conversation,
        ...(anthropicTools.length ? { tools: anthropicTools } : {}),
      });

      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      const functionCalls =
        response.stop_reason === 'tool_use'
          ? response.content
              .filter((block) => block.type === 'tool_use')
              .map((block) => ({ id: block.id, name: block.name, args: block.input }))
          : [];

      checkResponse(response, text, functionCalls, { warn: (m) => log.warn(m) });

      const inputTokens = response.usage?.input_tokens;
      const outputTokens = response.usage?.output_tokens;

      return {
        text,
        functionCalls,
        modelContent: response.content,
        // Wall-clock time includes the SDK's own retries.
        usage: {
          model,
          inputTokens,
          outputTokens,
          totalTokens:
            typeof inputTokens === 'number' && typeof outputTokens === 'number'
              ? inputTokens + outputTokens
              : undefined,
          latencyMs: clock() - startedAt,
          finishReason: response.stop_reason,
        },
      };
    };

    // Echoes the model's own content blocks back verbatim (rather than
    // reconstructing tool_use blocks from just {name, args, id}) for the same
    // reason as the Gemini adapter: don't drop provider metadata attached to
    // the original turn that a hand-built reconstruction might miss.
    const appendToolExchange = (conversation, modelResult, outcomes) => [
      ...conversation,
      { role: 'assistant', content: modelResult.modelContent },
      {
        role: 'user',
        content: outcomes.map(({ call, outcome }) => ({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }),
          is_error: !outcome.ok,
        })),
      },
    ];

    return runToolLoop({ initialState, callModel, appendToolExchange, executeTool });
  }

  return { generateReply };
}

export const { generateReply } = createAnthropicProvider({
  client,
  model: config.anthropicModel,
  maxOutputTokens: config.llmMaxOutputTokens,
  temperature: config.llmTemperature ?? DEFAULT_TEMPERATURE,
});
