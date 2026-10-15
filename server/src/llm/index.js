import { config } from '../config/env.js';
import * as anthropicProvider from './providers/anthropic.js';
import * as geminiProvider from './providers/gemini.js';
import * as demoProvider from './providers/demo.js';
import { businessTools, getToolDefinitions, createToolExecutor } from '../tools/index.js';
import * as searchKnowledgeBase from '../rag/searchKnowledgeBaseTool.js';
import { currentTrace } from '../trace/index.js';

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
//
// `options` exists for tests: a scripted `provider` and a `tools` list (for example with a knowledge-base
// tool over a fake retriever) run through exactly this code, executor, recorder and all. Production
// never passes it.
export async function generateReply({ systemPrompt, messages }, options = {}) {
  const provider = options.provider || PROVIDERS[config.llmProvider];
  const tools = options.tools || ALL_TOOLS;
  const executeToolFor = options.tools ? createToolExecutor(options.tools) : executeTool;

  if (!provider) {
    throw new Error(`Unknown LLM_PROVIDER "${config.llmProvider}".`);
  }

  // The per-turn trace, when this call is part of one (see trace/index.js). The tool step is opened
  // BEFORE the tool runs and closed after, so it keeps its place in the order when the tool records a
  // step of its own (a retrieval).
  const trace = currentTrace();
  const providerName = options.providerName || config.llmProvider;
  const modelId = options.modelId !== undefined ? options.modelId : config.llmProvider === 'gemini' ? config.geminiModel : config.llmProvider === 'anthropic' ? config.anthropicModel : null;
  trace?.setModel({ provider: providerName, model: modelId });

  const toolResults = [];
  const recordingExecutor = async (name, args) => {
    const finishStep = trace?.toolStarted(name, args);
    const outcome = await executeToolFor(name, args);
    finishStep?.(outcome);
    toolResults.push({ name, args, outcome });
    return outcome;
  };

  const startedAt = performance.now();
  const reply = await provider.generateReply({
    systemPrompt,
    messages,
    tools: options.tools ? getToolDefinitions(tools) : toolDefinitions,
    executeTool: recordingExecutor,
  });
  // The demo provider calls no model, and its adapter does not go through the tool loop. Say so in the
  // trace instead of leaving it looking as if a model ran.
  if (providerName === 'demo') {
    trace?.scriptedProvider({ provider: 'demo', latencyMs: performance.now() - startedAt });
  }
  return { ...reply, toolResults };
}
