import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/env.js';
import { runToolLoop } from '../toolLoop.js';

const client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

export const isConfigured = Boolean(client);

export function toAnthropicTools(tools) {
  return (tools || []).map(({ name, description, parameters }) => ({
    name,
    description,
    input_schema: parameters,
  }));
}

export async function generateReply({ systemPrompt, messages, tools = [], executeTool }) {
  if (!client) {
    throw new Error('Anthropic provider selected but ANTHROPIC_API_KEY is not set.');
  }

  const anthropicTools = toAnthropicTools(tools);
  const initialState = messages.map((m) => ({ role: m.role, content: m.content }));

  const callModel = async (conversation) => {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
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

    return { text, functionCalls, modelContent: response.content };
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
