import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/env.js';

const client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

export const isConfigured = Boolean(client);

export async function generateReply({ systemPrompt, messages }) {
  if (!client) {
    throw new Error('Anthropic provider selected but ANTHROPIC_API_KEY is not set.');
  }

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: systemPrompt,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
