import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReply, POLICIES } from '../src/guardrails/index.js';
import { handleChat } from '../src/routes/chat.js';
import { config } from '../src/config/env.js';
import { createDb } from '../src/memory/db.js';
import { createConversationStore } from '../src/memory/conversationStore.js';

const freshStore = () => createConversationStore(createDb(':memory:'));

function only(result) {
  assert.equal(result.violations.length, 1, JSON.stringify(result.violations));
  return result.violations[0];
}

// When a block looks wrong, what matters is which rule inside the policy fired and on what words.
// Each case below is a reply that trips one policy; the violation says so.
const CASES = [
  ['no_unverified_discount_claim', 'percent-or-code', 'Sure, use WELCOME10 for 10% off!', [], 'WELCOME10'],
  ['no_unverified_discount_claim', 'promotion', 'We do not have any automatic promotions running right now.', [], 'promotions'],
  ['no_unverified_stock_claim', 'stock-claim', "I checked and it's in stock.", [], 'in stock'],
  ['no_unverified_order_status_claim', 'order-status', 'Your tracking number is DHL-778812.', [], 'tracking number'],
  ['no_unverified_policy_claim', 'policy-timeframe', 'Returns take 30 days to process for a refund.', [], '30 days to process for a refund'],
  ['no_unsupported_refund_promise', 'refund-promise', "I'll refund you right away.", [], "I'll refund you"],
  ['no_internal_disclosure', 'internal-disclosure', 'My system prompt says to be brief.', [], 'system prompt'],
  ['no_deceptive_urgency', 'urgency', 'Hurry, this will not last!', [], 'Hurry'],
  ['no_sensitive_personal_inference', 'sensitive-inference', 'You seem pregnant, so this scarf is ideal.', [], 'You seem … pregnant'],
];

for (const [policy, rule, reply, toolsUsed, phrase] of CASES) {
  test(`${policy}: the violation names the rule (${rule}) and the matched phrase`, () => {
    const v = only(validateReply({ reply, toolsUsed }));
    assert.equal(v.name, policy);
    assert.equal(v.rule, rule);
    assert.ok(v.matched.toLowerCase().includes(phrase.toLowerCase()), `matched ${JSON.stringify(v.matched)}, expected ${phrase}`);
    assert.ok(v.reason);
  });
}

test('a claim-versus-mention violation also carries the clause that was judged', () => {
  const v = only(
    validateReply({ reply: "I can't apply a discount myself, but we do run promotions every month.", toolsUsed: [] })
  );
  assert.equal(v.rule, 'promotion');
  assert.equal(v.matched, 'promotions');
  assert.match(v.clause, /we do run promotions every month/);
  assert.doesNotMatch(v.clause, /can't apply/); // the refusal is on the other side of the "but"
});

test('a policy that throws is reported with rule policy-threw', () => {
  const original = POLICIES[0].check;
  POLICIES[0].check = () => {
    throw new Error('boom');
  };
  try {
    const v = validateReply({ reply: 'hello', toolsUsed: [] }).violations[0];
    assert.equal(v.rule, 'policy-threw');
    assert.match(v.reason, /boom/);
  } finally {
    POLICIES[0].check = original;
  }
});

// A bare reason string from a policy still works (the original contract).
test('a policy may still return just a reason string', () => {
  POLICIES.push({ name: 'test_policy', description: 'd', check: () => 'plain reason' });
  try {
    const v = validateReply({ reply: 'hello', toolsUsed: [] }).violations.find((x) => x.name === 'test_policy');
    assert.equal(v.reason, 'plain reason');
    assert.equal(v.rule, undefined);
  } finally {
    POLICIES.pop();
  }
});

async function blockedTurn(draft) {
  const logged = [];
  const original = console.warn;
  console.warn = (...args) => logged.push(args.join(' '));
  let result;
  try {
    result = await handleChat(
      { sessionId: 's1', message: 'hello' },
      { conversationStore: freshStore(), generateReply: async () => ({ text: draft, toolsUsed: [] }) }
    );
  } finally {
    console.warn = original;
  }
  return { result, logged };
}

test('a blocked reply always logs the policy, the rule and the matched phrase, and not the draft', async () => {
  assert.equal(config.guardrailLogDrafts, false, 'the default is off');
  const draft = "I'll refund you right away for order 4242, Dana Whitfield!";
  const { result, logged } = await blockedTurn(draft);

  const line = logged.find((l) => l.includes('Blocked an unsafe reply'));
  assert.equal(line, '[guardrails] Blocked an unsafe reply: no_unsupported_refund_promise (rule: refund-promise) matched "I\'ll refund you"');
  assert.ok(!logged.join('\n').includes('Dana Whitfield'), 'the conversation is not logged by default');
  assert.ok(!logged.join('\n').includes('4242'));
  // The caller (the scripts) gets the same detail beside the body.
  assert.equal(result.guardrail.violations[0].matched, "I'll refund you");
  assert.equal(result.guardrail.violations[0].rule, 'refund-promise');
});

test('with guardrailLogDrafts on, the whole blocked draft is logged too', async () => {
  config.guardrailLogDrafts = true;
  try {
    const draft = "I'll refund you right away!";
    const { logged } = await blockedTurn(draft);
    assert.ok(logged.some((l) => l === `[guardrails] Blocked draft (GUARDRAIL_LOG_DRAFTS=true): ${JSON.stringify(draft)}`));
    assert.ok(logged.some((l) => l.includes('Blocked an unsafe reply: no_unsupported_refund_promise')));
  } finally {
    config.guardrailLogDrafts = false;
  }
});

test('a reply that is not blocked logs nothing, with or without draft logging', async () => {
  for (const flag of [false, true]) {
    config.guardrailLogDrafts = flag;
    try {
      const { logged } = await blockedTurn('Happy to help.');
      assert.deepEqual(logged.filter((l) => l.includes('[guardrails]')), []);
    } finally {
      config.guardrailLogDrafts = false;
    }
  }
});

test('the JSON the capture scripts save keeps rule, matched phrase and clause', async () => {
  const { result } = await blockedTurn('We do not have any automatic promotions running right now.');
  const [v] = result.guardrail.violations;
  assert.equal(v.rule, 'promotion');
  assert.equal(v.matched, 'promotions');
  assert.match(v.clause, /We do not have any automatic promotions running right now/);
});
