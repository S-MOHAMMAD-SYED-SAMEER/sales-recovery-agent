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
