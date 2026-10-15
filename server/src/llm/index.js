import { config } from '../config/env.js';
import * as anthropicProvider from './providers/anthropic.js';
import * as geminiProvider from './providers/gemini.js';
import * as demoProvider from './providers/demo.js';
import { businessTools, getToolDefinitions, createToolExecutor } from '../tools/index.js';
import * as searchKnowledgeBase from '../rag/searchKnowledgeBaseTool.js';

const PROVIDERS = {
  gemini: geminiProvider,
  anthropic: anthropicProvider,
  demo: demoProvider,
};

// The agent's full tool list: the live-business-data tools plus the
// knowledge-base search tool, combined here (not inside tools/index.js or
// rag/index.js) so neither module needs to know the other exists — this is
// the one place that does.
const ALL_TOOLS = [...businessTools, searchKnowledgeBase];
const toolDefinitions = getToolDefinitions(ALL_TOOLS);
const executeTool = createToolExecutor(ALL_TOOLS);

// Returns { text, toolsUsed, toolResults }. toolsUsed lists every tool name the agent
// dispatched while producing this reply (in order, may repeat) — populated
// even when the underlying provider or a specific call declined every tool.
// toolResults has one { name, args, outcome } per dispatch, outcome being what the tool
// executor returned ({ ok, result } or { ok: false, error }): the record the guardrails
// use for a code verified in this turn and kept for the rest of the conversation. It is
// captured here, around the executor, so no provider or the tool loop has to know.
export async function generateReply({ systemPrompt, messages }) {
  const provider = PROVIDERS[config.llmProvider];

  if (!provider) {
    throw new Error(`Unknown LLM_PROVIDER "${config.llmProvider}".`);
  }

  const toolResults = [];
  const recordingExecutor = async (name, args) => {
    const outcome = await executeTool(name, args);
    toolResults.push({ name, args, outcome });
    return outcome;
  };

  const reply = await provider.generateReply({
    systemPrompt,
    messages,
    tools: toolDefinitions,
    executeTool: recordingExecutor,
  });
  return { ...reply, toolResults };
}
