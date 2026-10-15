import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignalDirective, detectSignals } from '../src/signals/index.js';

// What the model is told when a customer says "I like it, but I'm still deciding".
//
// A directive is a request, and these tests can only check what is being asked, not what a model does
// with it: that is measured on the real model (docs/results/, scripts/video-rehearsal.js). What they
// do pin is that the request names the actual return window, forbids inventing one, forbids the
// vague wording that was seen on a real reply, and keeps the rule against unverified discounts.

const hesitation = () => buildSignalDirective([{ type: 'purchase_hesitation', confidence: 0.7, evidence: 'still deciding' }]);

test('the hesitation directive asks for the return policy from the knowledge base, stated exactly', () => {
  const text = hesitation();
  assert.match(text, /Search the knowledge base for the store's return policy/);
  assert.match(text, /state the return window exactly as the knowledge base gives it/);
  assert.match(text, /the number of days/);
  assert.match(text, /one concrete thing it lists/);
  assert.match(text, /Use only facts from those search results/);
});

test('it forbids inventing or rounding a window, and the vague words a real reply used', () => {
  const text = hesitation();
  assert.match(text, /Never invent, round or estimate a window, a condition or a benefit/);
  for (const word of ['hassle-free', 'easy', 'no questions asked']) {
    assert.ok(text.includes(`"${word}"`), `does not rule out "${word}"`);
  }
  assert.match(text, /If the search finds nothing, say you cannot confirm the return policy right now/);
});

test('it never names a number of days itself: the window must come from the knowledge base', () => {
  // If the directive said "30 days", a model could repeat it without searching, and a policy change in
  // the knowledge base would not reach the reply.
  assert.doesNotMatch(hesitation(), /\b\d+[-\s]?days?\b/i);
  assert.doesNotMatch(hesitation(), /\b\d+\b/);
});

test('it still forbids a discount that was not verified with the tool', () => {
  assert.match(hesitation(), /Never invent or imply a discount that hasn't been verified with the discount tool/);
});

test('it is sent for a hesitant message, and the directives for the other signals are untouched', () => {
  const signals = detectSignals("I like it, but I'm still deciding");
  assert.ok(signals.some((s) => s.type === 'purchase_hesitation'));
  assert.match(buildSignalDirective(signals), /return window exactly as the knowledge base gives it/);

  const returnConcern = buildSignalDirective([{ type: 'return_concern', confidence: 0.7, evidence: 'x' }]);
  assert.match(returnConcern, /reassure them using the real return policy from the knowledge base/);
  assert.doesNotMatch(returnConcern, /hassle-free/);

  const price = buildSignalDirective([{ type: 'price_concern', confidence: 0.7, evidence: 'x' }]);
  assert.doesNotMatch(price, /return window/);
});
