import { GoogleGenAI } from '@google/genai';
import { config } from '../../config/env.js';

const client = config.geminiApiKey ? new GoogleGenAI({ apiKey: config.geminiApiKey }) : null;

export const isConfigured = Boolean(client);

// Gemini uses role "model" for assistant turns, not "assistant".
function toGeminiRole(role) {
  return role === 'assistant' ? 'model' : 'user';
}

export async function generateReply({ systemPrompt, messages }) {
  if (!client) {
    throw new Error('Gemini provider selected but GEMINI_API_KEY is not set.');
  }

  const response = await client.models.generateContent({
    model: config.geminiModel,
    config: {
      systemInstruction: systemPrompt,
    },
    contents: messages.map((m) => ({
      role: toGeminiRole(m.role),
      parts: [{ text: m.content }],
    })),
  });

  return response.text;
}
