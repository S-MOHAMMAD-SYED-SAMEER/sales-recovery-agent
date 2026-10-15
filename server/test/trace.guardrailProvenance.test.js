// Why a guardrail let a discount claim through, in the trace: recorded from the guardrail's own decision
// (the policy says what it relied on) and from the question numbers the conversation store kept when
// checkDiscount ran. Real handleChat -> generateReply -> tool loop -> real tools -> real guardrails ->
// real SQLite store; only the model is scripted. Nothing here is worked out afterwards from the reply.
//
// "Question n" is the customer's n-th message, from 1. Replies and tool calls are not counted, so a
// conversation full of tool turns cannot make the number drift away from what the customer typed.

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
const ORDER = [{ calls: [{ name: 'getOrderStatus', args: { orderId: '1001' } }] }, { text: 'Order 1001 has shipped.' }];
const STOCK = [{ calls: [{ name: 'checkStock', args: { product: 'Ceramic Mug' } }] }, { text: 'The Ceramic Mug is in stock.' }];
const CHAT = [{ text: 'Happy to help.' }];

test('verified on THIS question: the discount step passes and says so, naming the code', async () => {
  const result = await turn(freshStore(), 'Is WELCOME10 valid?', CHECK);
  const step = discountStep(result);

  assert.equal(step.outcome, 'pass');
  assert.deepEqual(step.verified, [{ code: 'WELCOME10', basis: 'this-turn', question: null, excerpt: null }]);
  assert.equal(step.note, 'WELCOME10: verified by checkDiscount on this question');
});

test('verified on an EARLIER question: it names the code, the question number and an excerpt of the question', async () => {
  const store = freshStore();
  await turn(store, 'hello', CHAT); // question 1
  await turn(store, 'Is WELCOME10 valid?', CHECK); // question 2: the tool runs here
  await turn(store, 'thanks', CHAT); // question 3
  const result = await turn(store, 'give me a 50% off code', CLAIM); // question 4: a claim, no tool

  const step = discountStep(result);
  assert.equal(step.outcome, 'pass');
  assert.deepEqual(step.verified, [{ code: 'WELCOME10', basis: 'earlier-turn', question: 2, excerpt: 'Is WELCOME10 valid?' }]);
  assert.equal(step.note, 'WELCOME10: verified by checkDiscount on question 2 ("Is WELCOME10 valid?")');
  // The decision itself is unchanged by the explanation: the reply was not blocked.
  assert.match(result.body.reply, /only code I can verify is WELCOME10/);
});

test('the number is the customer question number, and cannot drift with tool and assistant messages between questions', async () => {
  const store = freshStore();
  // Six questions first, four of them with tool calls (each of those turns also stores an assistant reply
  // and makes tool exchanges inside the model loop). The 7th question is the one that checks the code.
  await turn(store, 'order 1001 status', ORDER); // 1
  await turn(store, 'Is the Ceramic Mug in stock?', STOCK); // 2
  await turn(store, 'hello', CHAT); // 3
  await turn(store, 'order 1001 status again', ORDER); // 4
  await turn(store, 'and the mug?', STOCK); // 5
  await turn(store, 'thanks', CHAT); // 6
  await turn(store, 'Is WELCOME10 valid?', CHECK); // 7
  const result = await turn(store, 'any other code?', CLAIM); // 8

  // 8 customer messages and 16 stored messages: the number must be 7, never 14 or 16.
  assert.equal(store.countUserMessages('conv'), 8);
  assert.equal(store.getHistory('conv', 100).length, 16);
  assert.equal(discountStep(result).verified[0].question, 7);
  assert.match(discountStep(result).note, /on question 7 \("Is WELCOME10 valid\?"\)/);
  assert.doesNotMatch(discountStep(result).note, /question 1[0-9]/);
});

test('questions are counted per conversation: another conversation does not shift the number', async () => {
  const store = freshStore();
  for (let i = 0; i < 5; i += 1) await turn(store, `question ${i}`, CHAT, 'noisy');
  await turn(store, 'Is WELCOME10 valid?', CHECK, 'quiet'); // question 1 of "quiet"
  const result = await turn(store, 'any other code?', CLAIM, 'quiet');

  assert.equal(discountStep(result).verified[0].question, 1);
});

test('a code verified again later is attributed to the latest verification', async () => {
  const store = freshStore();
  await turn(store, 'Is WELCOME10 valid?', CHECK); // 1
  await turn(store, 'Is WELCOME10 still valid?', CHECK); // 2
  const result = await turn(store, 'any other code?', CLAIM); // 3
  assert.equal(discountStep(result).verified[0].question, 2);
  assert.match(discountStep(result).note, /on question 2 \("Is WELCOME10 still valid\?"\)/);
});

test('the excerpt is short, one line, plain text and scrubbed of secrets', async () => {
  const store = freshStore();
  const long = `Is WELCOME10 valid? ${'x'.repeat(400)}\nsecond line`;
  await turn(store, long, CHECK);
  const note = discountStep(await turn(store, 'again?', CLAIM)).note;

  assert.ok(!note.includes('\n'));
  assert.ok(note.length < 130, `note is ${note.length} characters`);
  assert.match(note, /^WELCOME10: verified by checkDiscount on question 1 \("Is WELCOME10 valid\? x+…"\)$/);
  assert.ok(store.getVerifiedQuestions('conv').WELCOME10.excerpt.length <= 120, 'the store caps it too');

  const store2 = freshStore();
  process.env.SRA_TEST_API_KEY = 'AIzaSyEXCERPTKEY0123456789abcdef';
  try {
    await turn(store2, `Is WELCOME10 valid? my key is ${process.env.SRA_TEST_API_KEY}`, CHECK);
    const result = await turn(store2, 'again?', CLAIM);
    assert.ok(!JSON.stringify(result.body).includes('AIzaSyEXCERPTKEY'));
    assert.match(discountStep(result).note, /\[redacted\]/);
  } finally {
    delete process.env.SRA_TEST_API_KEY;
  }
});

test('markup in the question is only ever text: the note is a plain string the page draws with a text node', async () => {
  const store = freshStore();
  await turn(store, 'Is WELCOME10 valid? <img src=x onerror=alert(1)>', CHECK);
  const result = await turn(store, 'again?', CLAIM);

  assert.equal(typeof discountStep(result).note, 'string');
  assert.match(discountStep(result).note, /<img src=x onerror=alert\(1\)>/); // shown as typed, never parsed
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

test('a reply with no discount claim says nothing about verification, and neither do the other policies', async () => {
  const store = freshStore();
  await turn(store, 'Is WELCOME10 valid?', CHECK);
  const result = await turn(store, 'hello', CHAT);
  assert.ok(result.body.trace.steps.filter((s) => s.type === 'guardrail').every((s) => s.note === undefined));

  const same = await turn(freshStore(), 'Is WELCOME10 valid?', CHECK);
  const others = same.body.trace.steps.filter((s) => s.type === 'guardrail' && s.policy !== 'no_unverified_discount_claim');
  assert.ok(others.length > 0 && others.every((s) => s.note === undefined && s.verified === undefined));
});

// ---- the guardrail's own report, and the wording -----------------------------------------------------------

test("validateReply reports what each policy relied on, from the policy's own decision", () => {
  const records = [{ code: 'WELCOME10', valid: true, percentOff: 10, description: '10% off for first-time customers', expires: '2027-10-15' }];
  const reply = 'WELCOME10 gives 10% off for first-time customers.';

  const earlier = validateReply({ reply, toolsUsed: [], verifiedDiscounts: records, verifiedQuestions: { WELCOME10: { question: 5, excerpt: 'which code?' } } });
  assert.equal(earlier.safe, true);
  assert.deepEqual(earlier.checks.find((c) => c.policy === 'no_unverified_discount_claim').verified, [
    { code: 'WELCOME10', basis: 'earlier-turn', question: 5, excerpt: 'which code?' },
  ]);

  const thisTurn = validateReply({ reply, toolsUsed: ['checkDiscount'], verifiedThisTurn: ['WELCOME10'] });
  assert.deepEqual(thisTurn.checks.find((c) => c.policy === 'no_unverified_discount_claim').verified, [
    { code: 'WELCOME10', basis: 'this-turn', question: null, excerpt: null },
  ]);

  const blocked = validateReply({ reply, toolsUsed: [] });
  assert.equal(blocked.safe, false);
  assert.deepEqual(blocked.checks.find((c) => c.policy === 'no_unverified_discount_claim').verified, []);
});

test('the wording: a known question is numbered and quoted, an unknown one says "an earlier question", a missing code is left out', () => {
  assert.equal(
    describeVerification({ code: 'WELCOME10', basis: 'earlier-turn', question: 1, excerpt: 'Is WELCOME10 valid?' }),
    'WELCOME10: verified by checkDiscount on question 1 ("Is WELCOME10 valid?")'
  );
  assert.equal(describeVerification({ code: 'WELCOME10', basis: 'earlier-turn', question: 3, excerpt: null }), 'WELCOME10: verified by checkDiscount on question 3');
  assert.equal(describeVerification({ code: 'WELCOME10', basis: 'earlier-turn', question: null, excerpt: null }), 'WELCOME10: verified by checkDiscount on an earlier question');
  assert.equal(describeVerification({ code: 'WELCOME10', basis: 'this-turn' }), 'WELCOME10: verified by checkDiscount on this question');
  assert.equal(describeVerification({ code: null, basis: 'this-turn' }), 'verified by checkDiscount on this question');
  assert.ok(!/turn/i.test(describeVerification({ code: 'X1', basis: 'earlier-turn', question: 2, excerpt: 'q' })), 'the word "turn" is gone from what a viewer reads');
});

// ---- what the store keeps ------------------------------------------------------------------------------------

test('the store keeps the question number and excerpt beside a verification, never inside the tool result', () => {
  const store = freshStore();
  const result = { code: 'WELCOME10', valid: true, percentOff: 10 };
  store.saveMessage('s', 'user', 'a');
  store.saveMessage('s', 'assistant', 'b');
  store.saveMessage('s', 'assistant', 'b2');
  store.saveMessage('s', 'user', 'c');
  assert.equal(store.countUserMessages('s'), 2, 'only customer messages are counted');
  store.saveVerifiedDiscount('s', result, 2, '  Is   WELCOME10\nvalid?  ');

  assert.deepEqual(store.getVerifiedDiscounts('s'), [result], 'the result is exactly what the tool returned');
  assert.deepEqual(store.getVerifiedQuestions('s'), { WELCOME10: { question: 2, excerpt: 'Is WELCOME10 valid?' } });
  assert.deepEqual(store.getVerifiedQuestions('nobody'), {});
  assert.equal(store.countUserMessages('nobody'), 0);
});

test('a number that is not a positive whole number, or a blank excerpt, is kept as unknown', () => {
  const store = freshStore();
  [0, -1, 1.5, '2', NaN, undefined].forEach((bad, i) => store.saveVerifiedDiscount('s', { code: `C${i}0` }, bad, '   '));
  const kept = Object.values(store.getVerifiedQuestions('s'));
  assert.equal(kept.length, 6);
  assert.ok(kept.every((q) => q.question === null && q.excerpt === null));
});

test('a database file made before these columns existed is upgraded in place, and its old rows say "an earlier question"', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sra-db-'));
  const file = path.join(dir, 'old.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE verified_discounts (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL, code TEXT NOT NULL, result TEXT NOT NULL, turn INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO conversations (session_id) VALUES ('conv');
    INSERT INTO verified_discounts (conversation_id, code, result, turn) VALUES (1, 'WELCOME10', '{"code":"WELCOME10","valid":true,"percentOff":10,"description":"10% off for first-time customers"}', NULL);
  `);
  old.close();

  const store = createConversationStore(createDb(file));
  assert.deepEqual(store.getVerifiedQuestions('conv'), { WELCOME10: { question: null, excerpt: null } });

  const result = await turn(store, 'which code?', CLAIM);
  assert.equal(discountStep(result).note, 'WELCOME10: verified by checkDiscount on an earlier question');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
