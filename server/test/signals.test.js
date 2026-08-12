import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSignals, buildSignalDirective, SIGNAL_TYPES } from '../src/signals/index.js';
import { SIGNAL_TYPE_NAMES } from '../src/signals/taxonomy.js';

test('taxonomy defines exactly the six required signal types', () => {
  assert.deepEqual(
    [...SIGNAL_TYPE_NAMES].sort(),
    [
      'cart_abandonment_risk',
      'price_concern',
      'purchase_hesitation',
      'purchase_intent',
      'return_concern',
      'shipping_concern',
    ]
  );
  for (const name of SIGNAL_TYPE_NAMES) {
    assert.equal(typeof SIGNAL_TYPES[name], 'string');
    assert.ok(SIGNAL_TYPES[name].length > 0);
  }
});

test('detects purchase_intent from checkout language', () => {
  const signals = detectSignals('How do I check out with this item?');
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, 'purchase_intent');
  assert.equal(typeof signals[0].confidence, 'number');
  assert.ok(signals[0].confidence > 0 && signals[0].confidence <= 1);
  assert.equal(typeof signals[0].evidence, 'string');
  assert.ok(signals[0].evidence.length > 0);
});

test('detects purchase_hesitation from indecision language', () => {
  const signals = detectSignals('I am still deciding, not sure if I need this.');
  assert.ok(signals.some((s) => s.type === 'purchase_hesitation'));
});

test('detects shipping_concern from worry about delivery', () => {
  const signals = detectSignals('I am worried about shipping — will it arrive on time?');
  assert.ok(signals.some((s) => s.type === 'shipping_concern'));
});

test('detects price_concern from affordability language', () => {
  const signals = detectSignals('This is too expensive for me, kind of out of my budget.');
  assert.ok(signals.some((s) => s.type === 'price_concern'));
});

test('detects return_concern from worry about returning an item', () => {
  const signals = detectSignals("What if it doesn't fit? I'm worried about the return process.");
  assert.ok(signals.some((s) => s.type === 'return_concern'));
});

test('detects cart_abandonment_risk from walking-away language', () => {
  const signals = detectSignals('Maybe later, I will think about it.');
  assert.ok(signals.some((s) => s.type === 'cart_abandonment_risk'));
});

test('a normal informational question produces no signals', () => {
  assert.deepEqual(detectSignals('What are your store hours?'), []);
  assert.deepEqual(detectSignals('Do you ship internationally?'), []);
});

test('an existing tool/RAG-style question produces no unnecessary signal', () => {
  assert.deepEqual(detectSignals('Is the Ceramic Mug in stock?'), []);
  assert.deepEqual(detectSignals('Where is my order 1001?'), []);
});

test('each detected signal is structured: type, confidence, evidence', () => {
  const signals = detectSignals('This is too expensive and I am still deciding.');
  assert.ok(signals.length >= 2);
  for (const signal of signals) {
    assert.equal(typeof signal.type, 'string');
    assert.ok(SIGNAL_TYPE_NAMES.includes(signal.type));
    assert.equal(typeof signal.confidence, 'number');
    assert.ok(signal.confidence > 0 && signal.confidence <= 1);
    assert.equal(typeof signal.evidence, 'string');
  }
});

test('attaches sourceMessageIndex when provided, omits it otherwise', () => {
  const withIndex = detectSignals('How do I check out?', { sourceMessageIndex: 4 });
  assert.equal(withIndex[0].sourceMessageIndex, 4);

  const withoutIndex = detectSignals('How do I check out?');
  assert.equal('sourceMessageIndex' in withoutIndex[0], false);
});

test('detection is based only on the current message — no memory of earlier turns', () => {
  const first = detectSignals('This is too expensive for me.');
  assert.ok(first.some((s) => s.type === 'price_concern'));

  // A later, unrelated message must not still carry the earlier signal.
  const second = detectSignals('What are your store hours?');
  assert.deepEqual(second, []);
});

test('buildSignalDirective returns an empty string when there are no signals', () => {
  assert.equal(buildSignalDirective([]), '');
  assert.equal(buildSignalDirective(undefined), '');
});

test('buildSignalDirective never tells the model to grant a specific discount or promise an outcome', () => {
  const signals = detectSignals('This is too expensive for me.');
  const directive = buildSignalDirective(signals);
  assert.match(directive, /price concern/i);
  // Must nudge tone, not hand out an unverified discount or make a promise.
  assert.doesNotMatch(directive, /\d+%\s*off/i);
  assert.doesNotMatch(directive, /\bpromise\b/i);
  assert.match(directive, /never invent/i);
});

test('buildSignalDirective dedupes repeated directive text for the same signal type', () => {
  // Two different phrasings that both map to purchase_hesitation.
  const signals = [
    { type: 'purchase_hesitation', confidence: 0.7, evidence: 'a' },
    { type: 'purchase_hesitation', confidence: 0.6, evidence: 'b' },
  ];
  const directive = buildSignalDirective(signals);
  const occurrences = directive.split('hesitant').length - 1;
  assert.equal(occurrences, 1);
});
