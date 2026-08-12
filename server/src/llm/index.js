import { config } from '../config/env.js';
import * as anthropicProvider from './providers/anthropic.js';
import * as geminiProvider from './providers/gemini.js';
import { getToolDefinitions, executeTool } from '../tools/index.js';

const PROVIDERS = {
  gemini: geminiProvider,
  anthropic: anthropicProvider,
};

// Returns { text, toolsUsed }. toolsUsed lists every tool name the agent
// dispatched while producing this reply (in order, may repeat) — populated
// even when the underlying provider or a specific call declined every tool.
export function generateReply({ systemPrompt, messages }) {
  const provider = PROVIDERS[config.llmProvider];

  if (!provider) {
    return Promise.reject(new Error(`Unknown LLM_PROVIDER "${config.llmProvider}".`));
  }

  return provider.generateReply({
    systemPrompt,
    messages,
    tools: getToolDefinitions(),
    executeTool,
  });
}
