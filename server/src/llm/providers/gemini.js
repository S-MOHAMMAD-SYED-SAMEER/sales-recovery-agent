import { GoogleGenAI } from '@google/genai';
import { config } from '../../config/env.js';
import { runToolLoop } from '../toolLoop.js';

const client = config.geminiApiKey ? new GoogleGenAI({ apiKey: config.geminiApiKey }) : null;

export const isConfigured = Boolean(client);

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

export async function generateReply({ systemPrompt, messages, tools = [], executeTool }) {
  if (!client) {
    throw new Error('Gemini provider selected but GEMINI_API_KEY is not set.');
  }

  const geminiTools = toGeminiTools(tools);
  const initialState = messages.map((m) => ({
    role: toGeminiRole(m.role),
    parts: [{ text: m.content }],
  }));

  const callModel = async (contents) => {
    const response = await client.models.generateContent({
      model: config.geminiModel,
      config: {
        systemInstruction: systemPrompt,
        ...(geminiTools ? { tools: geminiTools } : {}),
      },
      contents,
    });

    return {
      text: response.text,
      functionCalls: extractFunctionCalls(response),
      // The model's own turn, verbatim. Gemini 3.x attaches an internal
      // thought_signature to functionCall parts that MUST be echoed back
      // unchanged on the next turn — reconstructing the part by hand from
      // just {name, args} drops that signature and the API rejects the
      // follow-up call. See https://ai.google.dev/gemini-api/docs/thinking#signatures.
      modelContent: response.candidates?.[0]?.content,
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
