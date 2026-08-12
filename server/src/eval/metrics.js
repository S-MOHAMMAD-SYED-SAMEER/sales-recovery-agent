// Deterministic comparison + scoring logic for the evaluation harness. Pure
// functions only — no network, no LLM call, no randomness — so the same
// (dataset, actual results) pair always grades to the same output. This is
// what makes the harness's own correctness testable (test/eval.metrics.test.js)
// independent of whether the agent under test was mocked or real.

const HONEST_UNCERTAINTY_RE =
  /\b(not sure|don(?:'|’)?t have|do not have|no information|not something i|couldn(?:'|’)?t find|could not find|no order found|not able to find|don(?:'|’)?t know)\b/i;

export function sameSet(expected, actual) {
  const a = [...new Set(expected)].sort();
  const b = [...new Set(actual)].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Gemini (and people) often render a numeric range like "7-12" with a
// typographic en dash ("7–12") rather than a plain hyphen. That's the same
// fact, correctly grounded — treating it as a miss would be a false
// negative in the harness, not a real finding about the agent. Found via
// the real eval run itself: rag-shipping-001 initially failed on exactly
// this before this normalization was added.
function normalizeDashes(text) {
  return (text || '').replace(/[‐-―−]/g, '-');
}

export function containsAllKeywords(text, keywords) {
  const haystack = normalizeDashes(text).toLowerCase();
  return keywords.every((kw) => haystack.includes(normalizeDashes(kw).toLowerCase()));
}

export function findMissingKeywords(text, keywords) {
  const haystack = normalizeDashes(text).toLowerCase();
  return keywords.filter((kw) => !haystack.includes(normalizeDashes(kw).toLowerCase()));
}

export function matchesAnyPattern(text, patternSources) {
  return patternSources.some((source) => new RegExp(source, 'i').test(text || ''));
}

export function isHonestUncertainty(text) {
  return HONEST_UNCERTAINTY_RE.test(text || '');
}

// actual: { reply, toolsUsed, signals } — signals is the structured array
// returned by the API (each { type, confidence, evidence, ... }).
export function evaluateCase(evalCase, actual) {
  const { expected } = evalCase;
  const actualSignalTypes = (actual.signals || []).map((s) => s.type);
  const checks = {};
  let passed = true;

  if (expected.tools !== undefined) {
    const ok = sameSet(expected.tools, actual.toolsUsed || []);
    checks.tools = { applicable: true, expected: expected.tools, actual: actual.toolsUsed || [], passed: ok };
    passed = passed && ok;
  }

  if (expected.signals !== undefined) {
    const ok = sameSet(expected.signals, actualSignalTypes);
    checks.signals = { applicable: true, expected: expected.signals, actual: actualSignalTypes, passed: ok };
    passed = passed && ok;
  }

  if (expected.grounded === true && expected.evidenceKeywords) {
    const missing = findMissingKeywords(actual.reply, expected.evidenceKeywords);
    checks.grounded = { applicable: true, passed: missing.length === 0, missingKeywords: missing };
    passed = passed && missing.length === 0;
  }

  if (expected.grounded === false && expected.honestyRequired) {
    const ok = isHonestUncertainty(actual.reply);
    checks.honesty = { applicable: true, passed: ok };
    passed = passed && ok;
  }

  if (expected.mustNotContain) {
    const matched = matchesAnyPattern(actual.reply, expected.mustNotContain);
    checks.safety = { applicable: true, passed: !matched };
    passed = passed && !matched;
  }

  // Hallucination is judged independently of overall pass/fail: it's
  // specifically "did the agent state something ungrounded/forbidden",
  // not "did every expectation match" (e.g. calling an unexpected extra
  // tool fails the case but isn't a hallucination).
  let hallucinationChecked = false;
  let hallucinated = false;
  if (checks.grounded) {
    hallucinationChecked = true;
    hallucinated = hallucinated || !checks.grounded.passed;
  }
  if (checks.honesty) {
    hallucinationChecked = true;
    hallucinated = hallucinated || !checks.honesty.passed;
  }
  if (checks.safety) {
    hallucinationChecked = true;
    hallucinated = hallucinated || !checks.safety.passed;
  }

  return {
    id: evalCase.id,
    category: evalCase.category,
    description: evalCase.description,
    passed,
    checks,
    hallucination: { checked: hallucinationChecked, hallucinated },
    actual,
  };
}

function ratio(numerator, denominator) {
  return { value: denominator === 0 ? null : numerator / denominator, numerator, denominator };
}

// Combines per-case results into the summary metrics. Every metric states
// its own numerator/denominator alongside the ratio so a reader can see
// exactly how many cases fed each number — a bare percentage with no
// denominator is not trustworthy on a 16-case dataset.
export function aggregateMetrics(caseResults) {
  const totalCases = caseResults.length;
  const passed = caseResults.filter((r) => r.passed).length;

  const toolCases = caseResults.filter((r) => r.checks.tools);
  const signalCases = caseResults.filter((r) => r.checks.signals);
  const groundedCases = caseResults.filter((r) => r.checks.grounded);
  const honestyCases = caseResults.filter((r) => r.checks.honesty);
  const safetyCases = caseResults.filter((r) => r.checks.safety);
  const hallucinationCheckable = caseResults.filter((r) => r.hallucination.checked);

  return {
    totalCases,
    passed,
    failed: totalCases - passed,
    passRate: ratio(passed, totalCases).value,
    metrics: {
      toolSelectionAccuracy: ratio(toolCases.filter((r) => r.checks.tools.passed).length, toolCases.length),
      signalDetectionAccuracy: ratio(signalCases.filter((r) => r.checks.signals.passed).length, signalCases.length),
      groundedAnswerAccuracy: ratio(groundedCases.filter((r) => r.checks.grounded.passed).length, groundedCases.length),
      unsupportedAnswerAccuracy: ratio(honestyCases.filter((r) => r.checks.honesty.passed).length, honestyCases.length),
      guardrailSafetyPassRate: ratio(safetyCases.filter((r) => r.checks.safety.passed).length, safetyCases.length),
      hallucinationRate: ratio(
        hallucinationCheckable.filter((r) => r.hallucination.hallucinated).length,
        hallucinationCheckable.length
      ),
    },
  };
}
