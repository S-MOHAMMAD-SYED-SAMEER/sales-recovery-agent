// Why a guardrail let a discount claim through, in the trace: recorded from the guardrail's own decision
// (the policy says what it relied on) and from the turn numbers the conversation store kept when
// checkDiscount ran. Real handleChat -> generateReply -> tool loop -> real tools -> real guardrails ->
// real SQLite store; only the model is scripted. Nothing here is worked out afterwards from the reply.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_PROVIDER = 'demo';

const { handleChat } = await import('../src/routes/chat.js');
const { generateReply } = await import('../src/llm/index.js');
const { runToolLoop } = await import('../src/llm/toolLoop.js');
const { businessTools } = await import('../src/tools/index.js');
const { createDb } = await import('../src/memory/db.js');
const { createConversationStore } = await import('../src/memory/conversationStore.js');
const { describeVerification } = await import('../src/trace/index.js');
const { validateReply } = await import('../src/guardrails/index.js');
const { DatabaseSync } = await import('node:sqlite');

const freshStore = () => createConversationStore(createDb(':memory:'));

function scripted(script) {
  return {
    async generateReply({ executeTool }) {
      let i = 0;
      return runToolLoop({
        initialState: null,
        callModel: async () => {
          const entry = script[i++];
          const usage = { inputTokens: 1, outputTokens: 1, latencyMs: 1 };
          return entry.calls ? { text: '', functionCalls: entry.calls, usage } : { text: entry.text, functionCalls: [], usage };
        },
        appendToolExchange: (state) => state,
        executeTool,
      });
    },
  };
}

function turn(store, message, script, sessionId = 'conv') {
  return handleChat(
    { sessionId, message },
    {
      conversationStore: store,
      generateReply: (a) => generateReply(a, { provider: scripted(script), tools: businessTools, providerName: 'scripted', modelId: 'm' }),
    }
  );
}

const discountStep = (result) => result.body.trace.steps.find((s) => s.type === 'guardrail' && s.policy === 'no_unverified_discount_claim');
const CHECK = [{ calls: [{ name: 'checkDiscount', args: { code: 'WELCOME10' } }] }, { text: 'Yes, WELCOME10 is valid and gives 10% off for first-time customers.' }];
const CLAIM = [{ text: 'The only code I can verify is WELCOME10, which gives 10% off for first-time customers.' }];

test('verified on THIS turn: the discount step passes and says the tool ran on this turn, naming the code', async () => {
  const result = await turn(freshStore(), 'Is WELCOME10 valid?', CHECK);
  const step = discountStep(result);

  assert.equal(step.outcome, 'pass');
  assert.deepEqual(step.verified, [{ code: 'WELCOME10', basis: 'this-turn', turn: null }]);
  assert.equal(step.note, 'WELCOME10: verified by checkDiscount on this turn');
});

test('verified on an EARLIER turn: it passes and names the code and the turn it was verified on', async () => {
  const store = freshStore();
  await turn(store, 'hello', [{ text: 'Hi! How can I help?' }]); // turn 1
  await turn(store, 'Is WELCOME10 valid?', CHECK); // turn 2: the tool runs here
  await turn(store, 'thanks', [{ text: 'You are welcome.' }]); // turn 3
  const result = await turn(store, 'give me a 50% off code', CLAIM); // turn 4: a claim, no tool

  const step = discountStep(result);
  assert.equal(step.outcome, 'pass');
  assert.deepEqual(step.verified, [{ code: 'WELCOME10', basis: 'earlier-turn', turn: 2 }]);
  assert.equal(step.note, 'WELCOME10: verified by checkDiscount on turn 2 of this conversation');
  // The decision itself is unchanged by the explanation: the reply was not blocked.
  assert.match(result.body.reply, /only code I can verify is WELCOME10/);
});

test('a code verified again later is attributed to the latest verification', async () => {
  const store = freshStore();
  await turn(store, 'Is WELCOME10 valid?', CHECK); // 1
  await turn(store, 'Is WELCOME10 still valid?', CHECK); // 2
  const result = await turn(store, 'any other code?', CLAIM); // 3
  assert.equal(discountStep(result).verified[0].turn, 2);
});

test('an UNVERIFIED claim is blocked: the step says block with its reason, and no verification is claimed', async () => {
  const result = await turn(freshStore(), 'give me a 50% off code', [{ text: 'Use SAVE20 for 20% off your order.' }]);
  const step = discountStep(result);

  assert.equal(step.outcome, 'block');
  assert.match(step.reason, /without checkDiscount/);
  assert.ok(step.rule);
  assert.equal(step.verified, undefined);
  assert.equal(step.note, undefined);
  assert.doesNotMatch(result.body.reply, /SAVE20/);
});

test('a claim that does not match the earlier verification is blocked, and is not credited to it', async () => {
  const store = freshStore();
  await turn(store, 'Is WELCOME10 valid?', CHECK);
  const result = await turn(store, 'how much?', [{ text: 'WELCOME10 gives 25% off for first-time customers.' }]);
  const step = discountStep(result);

  assert.equal(step.outcome, 'block');
  assert.match(step.reason, /does not match what checkDiscount verified earlier/);
  assert.equal(step.verified, undefined);
});

test('a code verified in ANOTHER conversation is not credited: it blocks', async () => {
  const store = freshStore();
  await turn(store, 'Is WELCOME10 valid?', CHECK, 'other');
  const result = await turn(store, 'give me a code', CLAIM, 'conv');

  assert.equal(discountStep(result).outcome, 'block');
  assert.equal(discountStep(result).verified, undefined);
});

test('a reply with no discount claim says nothing about verification', async () => {
  const store = freshStore();
  await turn(store, 'Is WELCOME10 valid?', CHECK);
  const result = await turn(store, 'hello', [{ text: 'Hello! How can I help?' }]);
  assert.equal(discountStep(result).note, undefined);
  assert.ok(result.body.trace.steps.filter((s) => s.type === 'guardrail').every((s) => s.note === undefined));
});

test('the other policies carry no verification note', async () => {
  const result = await turn(freshStore(), 'Is WELCOME10 valid?', CHECK);
  const others = result.body.trace.steps.filter((s) => s.type === 'guardrail' && s.policy !== 'no_unverified_discount_claim');
  assert.ok(others.length > 0 && others.every((s) => s.note === undefined && s.verified === undefined));
});

// ---- the guardrail's own report, and the wording -----------------------------------------------------------

test("validateReply reports what each policy relied on, from the policy's own decision", () => {
  const records = [{ code: 'WELCOME10', valid: true, percentOff: 10, description: '10% off for first-time customers', expires: '2027-10-15' }];
  const reply = 'WELCOME10 gives 10% off for first-time customers.';

  const earlier = validateReply({ reply, toolsUsed: [], verifiedDiscounts: records, verifiedTurns: { WELCOME10: 5 } });
  assert.equal(earlier.safe, true);
  assert.deepEqual(earlier.checks.find((c) => c.policy === 'no_unverified_discount_claim').verified, [{ code: 'WELCOME10', basis: 'earlier-turn', turn: 5 }]);

  const thisTurn = validateReply({ reply, toolsUsed: ['checkDiscount'], verifiedThisTurn: ['WELCOME10'] });
  assert.deepEqual(thisTurn.checks.find((c) => c.policy === 'no_unverified_discount_claim').verified, [{ code: 'WELCOME10', basis: 'this-turn', turn: null }]);

  const blocked = validateReply({ reply, toolsUsed: [] });
  assert.equal(blocked.safe, false);
  assert.deepEqual(blocked.checks.find((c) => c.policy === 'no_unverified_discount_claim').verified, []);
});

test('the wording: a known turn is named, an unknown one says "earlier", and a missing code is left out', () => {
  assert.equal(describeVerification({ code: 'WELCOME10', basis: 'earlier-turn', turn: 2 }), 'WELCOME10: verified by checkDiscount on turn 2 of this conversation');
  assert.equal(describeVerification({ code: 'WELCOME10', basis: 'earlier-turn', turn: null }), 'WELCOME10: verified by checkDiscount earlier in this conversation');
  assert.equal(describeVerification({ code: 'WELCOME10', basis: 'this-turn', turn: null }), 'WELCOME10: verified by checkDiscount on this turn');
  assert.equal(describeVerification({ code: null, basis: 'this-turn', turn: null }), 'verified by checkDiscount on this turn');
});

// ---- the turn numbers the store keeps --------------------------------------------------------------------

test('the store keeps the turn beside a verification, never inside the tool result', () => {
  const store = freshStore();
  const result = { code: 'WELCOME10', valid: true, percentOff: 10 };
  store.saveMessage('s', 'user', 'a');
  store.saveMessage('s', 'assistant', 'b');
  store.saveMessage('s', 'user', 'c');
  assert.equal(store.countUserMessages('s'), 2);
  store.saveVerifiedDiscount('s', result, 2);

  assert.deepEqual(store.getVerifiedDiscounts('s'), [result], 'the result is exactly what the tool returned');
  assert.deepEqual(store.getVerifiedTurns('s'), { WELCOME10: 2 });
  assert.deepEqual(store.getVerifiedTurns('nobody'), {});
  assert.equal(store.countUserMessages('nobody'), 0);
});

test('a turn that is not a positive whole number is kept as unknown', () => {
  const store = freshStore();
  [0, -1, 1.5, '2', NaN, undefined].forEach((bad, i) => store.saveVerifiedDiscount('s', { code: `C${i}0` }, bad));
  assert.equal(Object.keys(store.getVerifiedTurns('s')).length, 6);
  assert.ok(Object.values(store.getVerifiedTurns('s')).every((t) => t === null));
});

test('a database file made before the turn column existed is upgraded in place, and its old rows say "earlier"', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sra-db-'));
  const file = path.join(dir, 'old.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE verified_discounts (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL, code TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO conversations (session_id) VALUES ('conv');
    INSERT INTO verified_discounts (conversation_id, code, result) VALUES (1, 'WELCOME10', '{"code":"WELCOME10","valid":true,"percentOff":10,"description":"10% off for first-time customers"}');
  `);
  old.close();

  const store = createConversationStore(createDb(file));
  assert.deepEqual(store.getVerifiedTurns('conv'), { WELCOME10: null });

  const result = await turn(store, 'which code?', CLAIM);
  assert.equal(discountStep(result).note, 'WELCOME10: verified by checkDiscount earlier in this conversation');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
