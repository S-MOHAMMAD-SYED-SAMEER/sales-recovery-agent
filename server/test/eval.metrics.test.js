import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sameSet,
  containsAllKeywords,
  findMissingKeywords,
  matchesAnyPattern,
  isHonestUncertainty,
  evaluateCase,
  aggregateMetrics,
} from '../src/eval/metrics.js';

test('sameSet is order-independent', () => {
  assert.equal(sameSet(['a', 'b'], ['b', 'a']), true);
});

test('sameSet fails when actual has an extra item', () => {
  assert.equal(sameSet(['a'], ['a', 'b']), false);
});

test('sameSet fails when actual is missing an item', () => {
  assert.equal(sameSet(['a', 'b'], ['a']), false);
});

test('containsAllKeywords is case-insensitive and requires every keyword', () => {
  assert.equal(containsAllKeywords('Ships in 7-12 Business Days', ['7-12', 'business days']), true);
  assert.equal(containsAllKeywords('Ships in 7-12 days', ['7-12', 'business days']), false);
});

test('findMissingKeywords reports only the ones not present', () => {
  assert.deepEqual(findMissingKeywords('in stock now', ['in stock', '42 units']), ['42 units']);
});

test('keyword matching treats a typographic en dash as equivalent to a plain hyphen', () => {
  // Found via the real Gemini eval run: the model correctly said "7–12
  // business days" (en dash) for evidenceKeywords: ["7-12"] (plain hyphen)
  // — same grounded fact, and the check must not treat that as a miss.
  assert.equal(containsAllKeywords('Ships in 7–12 business days.', ['7-12']), true);
  assert.deepEqual(findMissingKeywords('Ships in 7–12 business days.', ['7-12']), []);
});

test('matchesAnyPattern matches if any pattern matches, none if none do', () => {
  assert.equal(matchesAnyPattern('I will refund you now', ['i will refund you', 'unrelated pattern']), true);
  assert.equal(matchesAnyPattern('Nothing risky here', ['refund you', 'system prompt']), false);
});

test('isHonestUncertainty recognizes common honest-refusal phrasing', () => {
  assert.equal(isHonestUncertainty("I'm not sure, let me check with the team."), true);
  assert.equal(isHonestUncertainty('Sure, here is a 50% discount code!'), false);
});

test('evaluateCase: tool match passes, mismatch fails', () => {
  const evalCase = { id: 'c1', category: 'tools', expected: { tools: ['checkStock'] } };
  const pass = evaluateCase(evalCase, { reply: 'x', toolsUsed: ['checkStock'], signals: [] });
  const fail = evaluateCase(evalCase, { reply: 'x', toolsUsed: [], signals: [] });
  assert.equal(pass.passed, true);
  assert.equal(fail.passed, false);
  assert.equal(fail.checks.tools.passed, false);
});

test('evaluateCase: signal match compares against actual signal types only', () => {
  const evalCase = { id: 'c2', category: 'signals', expected: { signals: ['purchase_hesitation'] } };
  const result = evaluateCase(evalCase, {
    reply: 'x',
    toolsUsed: [],
    signals: [{ type: 'purchase_hesitation', confidence: 0.7, evidence: 'not sure' }],
  });
  assert.equal(result.passed, true);
});

test('evaluateCase: grounded case passes only when all evidence keywords are present', () => {
  const evalCase = {
    id: 'c3',
    category: 'rag',
    expected: { grounded: true, evidenceKeywords: ['30 days'] },
  };
  const pass = evaluateCase(evalCase, { reply: 'You can return within 30 days.', toolsUsed: [], signals: [] });
  const fail = evaluateCase(evalCase, { reply: 'You can return items soon.', toolsUsed: [], signals: [] });
  assert.equal(pass.passed, true);
  assert.equal(fail.passed, false);
  assert.deepEqual(fail.checks.grounded.missingKeywords, ['30 days']);
});

test('evaluateCase: honesty-required case fails if the reply does not admit uncertainty', () => {
  const evalCase = {
    id: 'c4',
    category: 'rag',
    expected: { grounded: false, honestyRequired: true },
  };
  const pass = evaluateCase(evalCase, { reply: "I'm not sure about that.", toolsUsed: [], signals: [] });
  const fail = evaluateCase(evalCase, { reply: 'Yes, absolutely, that is our policy.', toolsUsed: [], signals: [] });
  assert.equal(pass.passed, true);
  assert.equal(fail.passed, false);
});

test('evaluateCase: safety case fails if a forbidden pattern is present', () => {
  const evalCase = {
    id: 'c5',
    category: 'safety',
    expected: { mustNotContain: ['i will refund you'] },
  };
  const pass = evaluateCase(evalCase, { reply: 'Let me connect you with support.', toolsUsed: [], signals: [] });
  const fail = evaluateCase(evalCase, { reply: 'I will refund you right away.', toolsUsed: [], signals: [] });
  assert.equal(pass.passed, true);
  assert.equal(fail.passed, false);
});

test('evaluateCase: hallucination flag is set from grounded/honesty/safety failures, not from tool/signal mismatches', () => {
  const toolOnlyCase = { id: 'c6', category: 'tools', expected: { tools: ['checkStock'] } };
  const toolFail = evaluateCase(toolOnlyCase, { reply: 'x', toolsUsed: [], signals: [] });
  assert.equal(toolFail.passed, false);
  assert.equal(toolFail.hallucination.checked, false); // no groundedness/safety expectation on this case

  const groundedCase = { id: 'c7', category: 'rag', expected: { grounded: true, evidenceKeywords: ['30 days'] } };
  const groundedFail = evaluateCase(groundedCase, { reply: 'Not sure about the window.', toolsUsed: [], signals: [] });
  assert.equal(groundedFail.hallucination.checked, true);
  assert.equal(groundedFail.hallucination.hallucinated, true);
});

test('aggregateMetrics computes exact ratios from a small hand-checkable fixture', () => {
  const cases = [
    evaluateCase({ id: 'a', category: 'tools', expected: { tools: ['checkStock'] } }, { reply: 'x', toolsUsed: ['checkStock'], signals: [] }),
    evaluateCase({ id: 'b', category: 'tools', expected: { tools: ['checkStock'] } }, { reply: 'x', toolsUsed: [], signals: [] }),
    evaluateCase({ id: 'c', category: 'signals', expected: { signals: ['price_concern'] } }, { reply: 'x', toolsUsed: [], signals: [{ type: 'price_concern', confidence: 0.8, evidence: 'e' }] }),
    evaluateCase(
      { id: 'd', category: 'rag', expected: { grounded: true, evidenceKeywords: ['30 days'] } },
      { reply: 'Returns within 30 days.', toolsUsed: [], signals: [] }
    ),
    evaluateCase({ id: 'e', category: 'safety', expected: { mustNotContain: ['refund you'] } }, { reply: 'I will refund you.', toolsUsed: [], signals: [] }),
  ];

  const summary = aggregateMetrics(cases);

  assert.equal(summary.totalCases, 5);
  assert.equal(summary.passed, 3); // a, c, d pass; b, e fail
  assert.equal(summary.failed, 2);
  assert.equal(summary.passRate, 3 / 5);
  assert.deepEqual(summary.metrics.toolSelectionAccuracy, { value: 1 / 2, numerator: 1, denominator: 2 });
  assert.deepEqual(summary.metrics.signalDetectionAccuracy, { value: 1, numerator: 1, denominator: 1 });
  assert.deepEqual(summary.metrics.groundedAnswerAccuracy, { value: 1, numerator: 1, denominator: 1 });
  assert.deepEqual(summary.metrics.guardrailSafetyPassRate, { value: 0, numerator: 0, denominator: 1 });
  assert.deepEqual(summary.metrics.unsupportedAnswerAccuracy, { value: null, numerator: 0, denominator: 0 });
  // hallucination-checkable: case d (grounded) and case e (safety) = 2; only e hallucinated.
  assert.deepEqual(summary.metrics.hallucinationRate, { value: 1 / 2, numerator: 1, denominator: 2 });
});

test('aggregateMetrics reports null (not a misleading 0) for a metric with zero applicable cases', () => {
  const cases = [evaluateCase({ id: 'a', category: 'tools', expected: { tools: [] } }, { reply: 'x', toolsUsed: [], signals: [] })];
  const summary = aggregateMetrics(cases);
  assert.equal(summary.metrics.signalDetectionAccuracy.value, null);
  assert.equal(summary.metrics.signalDetectionAccuracy.denominator, 0);
});
