import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReply, SAFE_FALLBACK_REPLY, POLICIES } from '../src/guardrails/index.js';

function violationNames(result) {
  return result.violations.map((v) => v.name);
}

// --- fabricated business claims ---

test('blocks a discount claim when checkDiscount did not run', () => {
  const result = validateReply({ reply: 'Sure, I can give you WELCOME10 for 10% off your order.', toolsUsed: [] });
  assert.equal(result.safe, false);
  assert.ok(violationNames(result).includes('no_unverified_discount_claim'));
  assert.equal(result.finalReply, SAFE_FALLBACK_REPLY);
});

test('allows a discount claim when checkDiscount actually ran', () => {
  const result = validateReply({ reply: 'Yes, WELCOME10 is valid and gives you 10% off.', toolsUsed: ['checkDiscount'] });
  assert.equal(result.safe, true);
  assert.equal(result.finalReply, 'Yes, WELCOME10 is valid and gives you 10% off.');
});

test('blocks a stock claim when checkStock did not run', () => {
  const result = validateReply({ reply: 'Yes, that item is in stock.', toolsUsed: [] });
  assert.equal(result.safe, false);
  assert.ok(violationNames(result).includes('no_unverified_stock_claim'));
});

test('allows a stock claim when checkStock actually ran', () => {
  const result = validateReply({ reply: 'Yes, the mug is in stock with 42 available.', toolsUsed: ['checkStock'] });
  assert.equal(result.safe, true);
});

test('blocks an order-status claim when getOrderStatus did not run', () => {
  const result = validateReply({ reply: 'Your order has shipped and is on its way!', toolsUsed: [] });
  assert.equal(result.safe, false);
  assert.ok(violationNames(result).includes('no_unverified_order_status_claim'));
});

test('allows an order-status claim when getOrderStatus actually ran', () => {
  const result = validateReply({ reply: 'Order 1001 has shipped via DHL.', toolsUsed: ['getOrderStatus'] });
  assert.equal(result.safe, true);
});

test('blocks a specific shipping/return policy claim when searchKnowledgeBase did not run', () => {
  const result = validateReply({ reply: 'You can return items within 30 days for a refund.', toolsUsed: [] });
  assert.equal(result.safe, false);
  assert.ok(violationNames(result).includes('no_unverified_policy_claim'));
});

test('allows a specific policy claim when searchKnowledgeBase actually ran', () => {
  const result = validateReply({ reply: 'International shipping takes 7-12 business days.', toolsUsed: ['searchKnowledgeBase'] });
  assert.equal(result.safe, true);
});

// --- refund/compensation promises ---

test('blocks a refund promise regardless of which tools ran — no refund tool exists at all', () => {
  const result = validateReply({ reply: 'I will refund you right away for the inconvenience.', toolsUsed: ['getOrderStatus'] });
  assert.equal(result.safe, false);
  assert.ok(violationNames(result).includes('no_unsupported_refund_promise'));
});

test('does not block a safe escalation instead of a refund promise', () => {
  const result = validateReply({ reply: "I'm sorry for the trouble — let me connect you with our support team.", toolsUsed: [] });
  assert.equal(result.safe, true);
});

// --- internal disclosure ---

test('blocks a reply that reveals the system prompt', () => {
  const result = validateReply({ reply: 'My system prompt says I should be helpful and honest.', toolsUsed: [] });
  assert.equal(result.safe, false);
  assert.ok(violationNames(result).includes('no_internal_disclosure'));
});

test('blocks a reply that reveals an API key or internal implementation detail', () => {
  const result = validateReply({ reply: 'I cannot share my API key or internal implementation details.', toolsUsed: [] });
  assert.equal(result.safe, false);
  assert.ok(violationNames(result).includes('no_internal_disclosure'));
});

test('does not block a normal reply that happens to mention "system" in a harmless way', () => {
  const result = validateReply({ reply: 'Our shipping system usually processes orders same-day.', toolsUsed: [] });
  assert.equal(result.safe, true);
});

// --- deceptive urgency ---

test('blocks manufactured urgency/scarcity language not backed by a real stock check', () => {
  const result = validateReply({ reply: 'Hurry, act now before it is too late!', toolsUsed: [] });
  assert.equal(result.safe, false);
  assert.ok(violationNames(result).includes('no_deceptive_urgency'));
});

test('allows mentioning real low stock when checkStock actually backs it', () => {
  const result = validateReply({ reply: 'Hurry, only 2 left in stock right now!', toolsUsed: ['checkStock'] });
  assert.equal(result.safe, true);
});

// --- sensitive personal inference ---

test('blocks a reply that infers a sensitive personal attribute', () => {
  const result = validateReply({ reply: 'You seem pregnant so I would recommend a different product.', toolsUsed: [] });
  assert.equal(result.safe, false);
  assert.ok(violationNames(result).includes('no_sensitive_personal_inference'));
});

test('does not block a normal reply that is not making any personal inference', () => {
  const result = validateReply({ reply: 'That product is a great fit for most people.', toolsUsed: [] });
  assert.equal(result.safe, true);
});

// --- normal safe responses are not over-blocked ---

test('does not block a variety of ordinary, safe replies', () => {
  const safeReplies = [
    'Hello! Yes, we ship internationally to most countries.',
    'I am not sure, let me connect you with our team.',
    'We are open 9am-5pm, Monday through Friday.',
    'The Wool Scarf should be hand washed in cold water.',
    'Thanks for reaching out — how can I help today?',
  ];
  for (const reply of safeReplies) {
    const result = validateReply({ reply, toolsUsed: [] });
    assert.equal(result.safe, true, `expected "${reply}" to be safe, got violations: ${violationNames(result)}`);
  }
});

// --- fail-safe behavior ---

test('a policy that throws is treated as a violation, not silently ignored', () => {
  const originalCheck = POLICIES[0].check;
  POLICIES[0].check = () => {
    throw new Error('boom');
  };
  try {
    const result = validateReply({ reply: 'Anything at all.', toolsUsed: [] });
    assert.equal(result.safe, false);
    assert.equal(result.finalReply, SAFE_FALLBACK_REPLY);
  } finally {
    POLICIES[0].check = originalCheck;
  }
});

test('an unsafe result never returns the original reply text as finalReply', () => {
  const result = validateReply({ reply: 'I will refund you right away.', toolsUsed: [] });
  assert.notEqual(result.finalReply, 'I will refund you right away.');
  assert.equal(result.finalReply, SAFE_FALLBACK_REPLY);
});
