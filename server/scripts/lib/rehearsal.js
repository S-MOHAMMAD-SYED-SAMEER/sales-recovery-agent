// The judgements `scripts/video-rehearsal.js` makes about a run, as pure functions so they can be
// tested without a model, a network or a script that starts itself on import.

// A knowledge-base failure is not a result, it is a broken measurement: with retrieval down the
// model answers "still deciding" from nothing, the reply looks fine, and the run says nothing
// about the reply the video promises. So any sign of it is an error that stops the run.
//
// Two independent signs, either is enough:
//   * the tool said so: a searchKnowledgeBase outcome that failed, or that reports unavailable;
//   * the app logged so: the two messages the retrieval path writes when Chroma cannot be used.
const KB_LOG_PATTERNS = [/Knowledge-base retrieval failed/i, /Chroma operation failed/i];

export function knowledgeBaseProblem(toolResults, logLines = []) {
  for (const { name, outcome } of Array.isArray(toolResults) ? toolResults : []) {
    if (name !== 'searchKnowledgeBase') continue;
    if (!outcome?.ok) return `the searchKnowledgeBase tool failed (${outcome?.error ?? 'no detail'})`;
    if (outcome.result?.unavailable) return 'the searchKnowledgeBase tool reported the knowledge base unavailable';
  }
  for (const line of logLines) {
    if (KB_LOG_PATTERNS.some((pattern) => pattern.test(line))) return `the app logged: ${String(line).slice(0, 120)}`;
  }
  return null;
}

// What the knowledge base says about returns, read from the file itself, so "cites the real return
// policy" means the number that is actually in the policy and not one this script remembers.
export function returnWindowDays(returnsPolicyText) {
  const match = /within\s+(\d+)\s+days/i.exec(returnsPolicyText);
  return match ? Number(match[1]) : null;
}

// Whether a reply states that window ("30 days", "30-day"). A reply that only says "returns" does not.
export function citesReturnWindow(reply, days) {
  if (!Number.isInteger(days)) return false;
  return new RegExp(`\\b${days}[-\\s]?days?\\b`, 'i').test(String(reply));
}

// A short, text-free account of what a step used from the knowledge base: whether it searched,
// whether it found anything, and from which files. Never the passages themselves.
export function knowledgeBaseUse(toolResults) {
  const searches = (Array.isArray(toolResults) ? toolResults : []).filter((entry) => entry.name === 'searchKnowledgeBase');
  if (searches.length === 0) return { searched: false, found: false, sources: [] };
  const sources = new Set();
  let found = false;
  for (const { outcome } of searches) {
    if (outcome?.ok && outcome.result?.found) {
      found = true;
      for (const hit of outcome.result.results ?? []) if (hit.source) sources.add(hit.source);
    }
  }
  return { searched: true, found, sources: [...sources].sort() };
}

// Per prompt: how many were answered and how many of those a guardrail blocked.
export function summarisePrompts(steps, rows) {
  return steps.map((step) => {
    const forStep = rows.filter((row) => row.step === step.id);
    const answered = forStep.filter((row) => row.status === 200);
    return {
      step: step.id,
      message: step.message,
      answered: answered.length,
      blocked: answered.filter((row) => row.blocked).length,
      noAnswer: forStep.length - answered.length,
    };
  });
}

// The pass condition for recording. Every one of these must hold:
//   * the run was not stopped (an outage, a quota, a broken knowledge base);
//   * every critical prompt was answered in every take;
//   * none of the critical replies was blocked by a guardrail;
//   * every "still deciding" reply states the real return window, having searched and found it.
export function judge({ perPrompt, rows, runs, mustNotBlock, citedStep, aborted }) {
  const critical = perPrompt.filter((entry) => mustNotBlock.has(entry.step));
  const criticalAnswered = critical.reduce((n, entry) => n + entry.answered, 0);
  const criticalBlocked = critical.reduce((n, entry) => n + entry.blocked, 0);
  const cited = rows.filter((row) => row.step === citedStep && row.status === 200 && row.citesReturnPolicy && row.knowledgeBase?.found);
  const complete = !aborted && criticalAnswered === runs * mustNotBlock.size;
  return {
    pass: complete && criticalBlocked === 0 && cited.length === runs,
    criticalAnswered,
    criticalBlocked,
    citedReturnPolicy: cited.length,
    takes: runs,
  };
}

// Whether the trace a reply came with agrees with what the turn really did. The trace is recorded by
// the server as the turn runs, and the same turn also yields `toolsUsed`, `signals`, the usage record
// and the guardrail verdict, which are produced by other code. A trace that disagrees with them is a
// bug in the recording, so the rehearsal compares them on every reply it makes. Returns a list of
// problems (empty when the trace is consistent).
//
//   turn: { body: { trace, toolsUsed, signals }, usage, guardrail: { safe }, toolResults }
//   policyNames: the guardrail policies that should have been checked, in order
//   secrets: strings that must appear nowhere in the trace (the API key)
export function traceProblems(turn, { policyNames = [], secrets = [] } = {}) {
  const problems = [];
  const trace = turn?.body?.trace;
  if (!trace || !Array.isArray(trace.steps)) return ['the reply has no trace'];
  const steps = trace.steps;
  const of = (type) => steps.filter((s) => s.type === type);

  if (typeof trace.totalMs !== 'number' || trace.totalMs < 0) problems.push('totalMs is not a number');

  const tools = of('tool').map((s) => s.name);
  const toolsUsed = turn.body.toolsUsed ?? [];
  if (JSON.stringify(tools) !== JSON.stringify(toolsUsed)) problems.push(`tool steps ${JSON.stringify(tools)} differ from toolsUsed ${JSON.stringify(toolsUsed)}`);

  const searched = toolsUsed.filter((n) => n === 'searchKnowledgeBase').length;
  if (of('retrieve').length !== searched) problems.push(`${of('retrieve').length} retrieve step(s) for ${searched} knowledge-base search(es)`);
  for (const r of of('retrieve')) {
    if (!r.unavailable && r.sources.length > 0 && !r.chunks.every((c) => c.id)) problems.push('a retrieved chunk has no id');
  }

  const signals = (turn.body.signals ?? []).map((s) => s.type);
  const traced = of('signal').map((s) => s.signal);
  if (JSON.stringify(signals) !== JSON.stringify(traced)) problems.push(`signal steps ${JSON.stringify(traced)} differ from signals ${JSON.stringify(signals)}`);

  const calls = turn.usage?.calls ?? null;
  if (calls !== null && of('model').length !== calls) problems.push(`${of('model').length} model step(s) for ${calls} model call(s)`);
  if (calls !== null && of('model').some((m) => typeof m.latencyMs !== 'number' || typeof m.tokensIn !== 'number' || typeof m.tokensOut !== 'number')) {
    problems.push('a model step lacks latency or token counts');
  }

  const checks = of('guardrail');
  if (policyNames.length && JSON.stringify(checks.map((c) => c.policy)) !== JSON.stringify(policyNames)) problems.push('the guardrail steps are not one per policy, in order');
  if (checks.some((c) => c.outcome === 'block') === Boolean(turn.guardrail?.safe)) problems.push('the guardrail steps disagree with the guardrail verdict');

  const order = steps.map((s) => s.type);
  const firstGuardrail = order.indexOf('guardrail');
  if (firstGuardrail !== -1 && order.slice(firstGuardrail).some((t) => t !== 'guardrail')) problems.push('a step follows the guardrail steps');
  if (order.includes('signal') && order.indexOf('signal') !== 0) problems.push('a signal step is not first');

  const text = JSON.stringify(trace);
  for (const secret of secrets) if (secret && text.includes(secret)) problems.push('the trace contains a secret');
  return problems;
}
