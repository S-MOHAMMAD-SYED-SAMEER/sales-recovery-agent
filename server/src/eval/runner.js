import { createDb } from '../memory/db.js';
import { createConversationStore } from '../memory/conversationStore.js';
import { handleChat } from '../routes/chat.js';
import { evaluateCase, aggregateMetrics } from './metrics.js';

// Mock mode replays each case's own `mockResponse` instead of calling a
// real LLM — this is what makes mock-mode runs deterministic and free, and
// is what test/eval.runner.test.js exercises to prove the harness itself
// grades correctly, independent of any real model's behavior.
function buildMockGenerateReply(evalCase) {
  return async () => {
    if (!evalCase.mockResponse) {
      throw new Error(`Case "${evalCase.id}" has no mockResponse; cannot run it in mock mode.`);
    }
    return { text: evalCase.mockResponse.text, toolsUsed: evalCase.mockResponse.toolsUsed };
  };
}

function failedCaseResult(evalCase, error) {
  return {
    id: evalCase?.id ?? '(unknown)',
    category: evalCase?.category ?? '(unknown)',
    description: evalCase?.description,
    passed: false,
    checks: {},
    hallucination: { checked: false, hallucinated: false },
    actual: { reply: null, toolsUsed: [], signals: [] },
    error: error.message,
  };
}

// Runs one case through the *real* handleChat — the same function
// routes/chat.js uses for a live request — so evaluation exercises the
// actual signal detection, tool loop / RAG, and guardrail pipeline exactly
// as a real user would hit it. Only the LLM call itself is swapped for a
// script in mock mode; everything downstream of it (guardrails, memory,
// signal detection) is the real deterministic code either way.
async function runCase(evalCase, { mode, generateReply }) {
  const conversationStore = createConversationStore(createDb(':memory:'));

  for (const turn of evalCase.priorTurns || []) {
    conversationStore.saveMessage(evalCase.id, turn.role, turn.content);
  }

  const effectiveGenerateReply = mode === 'mock' ? buildMockGenerateReply(evalCase) : generateReply;

  const result = await handleChat(
    { sessionId: evalCase.id, message: evalCase.message },
    { conversationStore, generateReply: effectiveGenerateReply }
  );

  if (result.status !== 200) {
    return evaluateCase(evalCase, {
      reply: `[HTTP ${result.status}] ${result.body?.error || 'request failed'}`,
      toolsUsed: [],
      signals: [],
    });
  }

  return evaluateCase(evalCase, {
    reply: result.body.reply,
    toolsUsed: result.body.toolsUsed,
    signals: result.body.signals,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// dataset must already be schema-valid (see eval/schema.js — callers should
// validate before running). mode: 'mock' (default, deterministic, free) or
// 'real' (requires a real generateReply, e.g. from llm/index.js). A single
// malformed/erroring case never aborts the whole run — it's recorded as a
// failed case with its error message, so one bad case doesn't hide results
// for the other fifteen.
//
// delayMsBetweenCases: only applied in 'real' mode, before every case after
// the first. Exists because the free-tier Gemini quota (15 requests/minute)
// is easily exceeded running 16 cases back to back with zero pacing — a
// 429 there is a quota artifact, not a real finding about the agent, and
// without pacing it silently masquerades as agent failures in the results.
// Default is 0 (no delay) so mock-mode runs and unit tests stay instant.
export async function runEvaluation({ dataset, mode = 'mock', generateReply, delayMsBetweenCases = 0 }) {
  if (mode === 'real' && typeof generateReply !== 'function') {
    throw new Error('runEvaluation({ mode: "real" }) requires a generateReply function.');
  }

  const caseResults = [];
  for (const [index, evalCase] of dataset.cases.entries()) {
    if (mode === 'real' && index > 0 && delayMsBetweenCases > 0) {
      await sleep(delayMsBetweenCases);
    }
    try {
      caseResults.push(await runCase(evalCase, { mode, generateReply }));
    } catch (err) {
      caseResults.push(failedCaseResult(evalCase, err));
    }
  }

  const summary = aggregateMetrics(caseResults);

  return {
    datasetVersion: dataset.version,
    mode,
    ...summary,
    cases: caseResults,
  };
}
