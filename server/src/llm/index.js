import { config } from '../config/env.js';
import * as anthropicProvider from './providers/anthropic.js';
import * as geminiProvider from './providers/gemini.js';

const PROVIDERS = {
  gemini: geminiProvider,
  anthropic: anthropicProvider,
};

export function generateReply({ systemPrompt, messages }) {
  const provider = PROVIDERS[config.llmProvider];

  if (!provider) {
    return Promise.reject(new Error(`Unknown LLM_PROVIDER "${config.llmProvider}".`));
  }

  return provider.generateReply({ systemPrompt, messages });
}
