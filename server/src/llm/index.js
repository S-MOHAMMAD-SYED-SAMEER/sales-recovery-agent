import { config } from '../config/env.js';
import * as anthropicProvider from './providers/anthropic.js';
import * as geminiProvider from './providers/gemini.js';
import { businessTools, getToolDefinitions, createToolExecutor } from '../tools/index.js';
import * as searchKnowledgeBase from '../rag/searchKnowledgeBaseTool.js';

const PROVIDERS = {
  gemini: geminiProvider,
  anthropic: anthropicProvider,
};

// The agent's full tool list: M3's live-business-data tools plus M4's
// knowledge-base search tool, combined here (not inside tools/index.js or
// rag/index.js) so neither module needs to know the other exists — this is
// the one place that does.
const ALL_TOOLS = [...businessTools, searchKnowledgeBase];
const toolDefinitions = getToolDefinitions(ALL_TOOLS);
const executeTool = createToolExecutor(ALL_TOOLS);

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
    tools: toolDefinitions,
    executeTool,
  });
}
