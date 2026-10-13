import { createDb } from '../memory/db.js';
import { createConversationStore } from '../memory/conversationStore.js';
import { handleChat } from '../routes/chat.js';
import { evaluateCase, aggregateMetrics } from './metrics.js';
import { combineUsage } from '../llm/usage.js';

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
    // The model never answered (a quota, a timeout, a block, an outage). That is
    // not something the agent said, so it must not be graded as if it were: the
    // reply "[HTTP 502]" would trivially pass every "must not contain" check and
    // flatter the safety numbers. It is recorded as a failed case with no checks,
    // so it counts against the pass rate but is left out of every metric's
    // denominator.
    return {
      ...failedCaseResult(evalCase, new Error(`HTTP ${result.status}: ${result.body?.error || 'request failed'}`)),
      providerError: true,
    };
  }

  // Tokens and latency of the model calls behind this reply: null in mock mode,
  // where no model is called.
  return {
    ...evaluateCase(evalCase, {
      reply: result.body.reply,
      toolsUsed: result.body.toolsUsed,
      signals: result.body.signals,
    }),
    usage: result.usage ?? null,
  };
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
//
// maxConsecutiveProviderErrors: in real mode, stop the run after this many cases
// in a row that got no answer from the model (0 = never stop). A quota or an
// outage that retries could not clear will not clear on the next case either, and
// carrying on would only spend more calls on a service that is refusing them.
// The result then has `aborted` set and lists how many cases were not run.
export async function runEvaluation({
  dataset,
  mode = 'mock',
  generateReply,
  delayMsBetweenCases = 0,
  maxConsecutiveProviderErrors = 0,
}) {
  if (mode === 'real' && typeof generateReply !== 'function') {
    throw new Error('runEvaluation({ mode: "real" }) requires a generateReply function.');
  }

  const caseResults = [];
  let consecutiveProviderErrors = 0;
  let aborted = null;
  for (const [index, evalCase] of dataset.cases.entries()) {
    if (mode === 'real' && index > 0 && delayMsBetweenCases > 0) {
      await sleep(delayMsBetweenCases);
    }
    try {
      caseResults.push(await runCase(evalCase, { mode, generateReply }));
    } catch (err) {
      caseResults.push(failedCaseResult(evalCase, err));
    }

    const last = caseResults[caseResults.length - 1];
    consecutiveProviderErrors = last.providerError ? consecutiveProviderErrors + 1 : 0;
    if (
      mode === 'real' &&
      maxConsecutiveProviderErrors > 0 &&
      consecutiveProviderErrors >= maxConsecutiveProviderErrors &&
      index < dataset.cases.length - 1
    ) {
      aborted = {
        reason: `${consecutiveProviderErrors} cases in a row got no answer from the model; stopped so as not to keep spending calls.`,
        lastCase: evalCase.id,
        lastError: last.error,
        casesNotRun: dataset.cases.length - (index + 1),
      };
      break;
    }
  }

  const summary = aggregateMetrics(caseResults);

  return {
    datasetVersion: dataset.version,
    mode,
    ...summary,
    // Run totals of the per-case usage: calls, tokens, time. Null in mock mode.
    usage: combineUsage(caseResults.map((c) => c.usage)),
    aborted,
    cases: caseResults,
  };
}
