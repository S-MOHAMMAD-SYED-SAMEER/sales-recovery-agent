import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { citesReturnWindow, judge, knowledgeBaseProblem, knowledgeBaseUse, returnWindowDays, summarisePrompts, traceProblems, withinBudget } from '../scripts/lib/rehearsal.js';
import { generateReply } from '../src/llm/index.js';
import { runToolLoop } from '../src/llm/toolLoop.js';
import { businessTools } from '../src/tools/index.js';
import { POLICIES } from '../src/guardrails/index.js';
import { handleChat } from '../src/routes/chat.js';
import { createDb } from '../src/memory/db.js';
import { createConversationStore } from '../src/memory/conversationStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');

const found = {
  name: 'searchKnowledgeBase',
  args: { query: 'returns' },
  outcome: { ok: true, result: { found: true, results: [{ source: 'returns-policy.md', heading: 'Return Window', text: 'PRIVATE PASSAGE TEXT' }] } },
};
const unavailable = { name: 'searchKnowledgeBase', args: { query: 'returns' }, outcome: { ok: true, result: { found: false, unavailable: true, message: 'x' } } };
const empty = { name: 'searchKnowledgeBase', args: { query: 'moon' }, outcome: { ok: true, result: { found: false, message: 'nothing relevant' } } };

// --- a knowledge-base failure is an error, never a quiet degradation ------------------------------------

test('an unavailable knowledge base, a failed search, or a retrieval failure in the log is a problem', () => {
  assert.match(knowledgeBaseProblem([unavailable]), /unavailable/);
  assert.match(
    knowledgeBaseProblem([{ name: 'searchKnowledgeBase', outcome: { ok: false, error: 'searchKnowledgeBase failed to execute.' } }]),
    /tool failed/
  );
  assert.match(knowledgeBaseProblem([], ['[rag] Knowledge-base retrieval failed: Failed to connect to chromadb.']), /logged/);
  assert.match(knowledgeBaseProblem([], ['[vectorStore] Chroma operation failed (x) - refreshing']), /logged/);
  // Either sign is enough, even beside a search that looked fine.
  assert.ok(knowledgeBaseProblem([found], ['[rag] Knowledge-base retrieval failed: boom']));
});

test('a healthy search, an honest "nothing relevant", and unrelated tools are not problems', () => {
  assert.equal(knowledgeBaseProblem([found], ['[chat] model usage: calls=2']), null);
  assert.equal(knowledgeBaseProblem([empty], []), null, 'the store answered and has nothing: an answer, not a failure');
  assert.equal(knowledgeBaseProblem([{ name: 'checkDiscount', outcome: { ok: false, error: 'x' } }], []), null);
  assert.equal(knowledgeBaseProblem(undefined, undefined), null);
});

// --- citing the real return policy -------------------------------------------------------------------------

test('the return window is read from the knowledge base file, and a reply either states it or does not', () => {
  const policy = fs.readFileSync(path.join(serverDir, 'data/kb/returns-policy.md'), 'utf8');
  const days = returnWindowDays(policy);
  assert.equal(days, 30);
  assert.equal(returnWindowDays('No window stated here.'), null);

  assert.equal(citesReturnWindow('You can return items within 30 days of delivery.', days), true);
  assert.equal(citesReturnWindow('We have a 30-day return window.', days), true);
  assert.equal(citesReturnWindow('Take your time! Ask about shipping or returns any time.', days), false);
  assert.equal(citesReturnWindow('Returns within 130 days', days), false, 'a different number is not the window');
  assert.equal(citesReturnWindow('within 30 days', null), false);
});

test('what a step used from the knowledge base is recorded without any passage text', () => {
  const use = knowledgeBaseUse([found, empty]);
  assert.deepEqual(use, { searched: true, found: true, sources: ['returns-policy.md'] });
  assert.ok(!JSON.stringify(use).includes('PRIVATE PASSAGE TEXT'));
  assert.deepEqual(knowledgeBaseUse([]), { searched: false, found: false, sources: [] });
  assert.deepEqual(knowledgeBaseUse([unavailable]), { searched: true, found: false, sources: [] });
});

// --- the verdict --------------------------------------------------------------------------------------------

const STEPS = [
  { id: 'order', message: 'o' },
  { id: '50off', message: 'f' },
  { id: 'deciding', message: 'd' },
];
const MUST = new Set(['50off', 'deciding']);

function rowsFor(runs, { blocked = {}, cited = true, kbFound = true, drop = null } = {}) {
  const rows = [];
  for (let take = 1; take <= runs; take += 1) {
    for (const step of STEPS) {
      if (drop && drop.take === take && drop.step === step.id) {
        rows.push({ take, step: step.id, status: 502 });
        continue;
      }
      rows.push({
        take,
        step: step.id,
        status: 200,
        blocked: blocked[step.id]?.includes(take) ?? false,
        ...(step.id === 'deciding' ? { citesReturnPolicy: cited, knowledgeBase: { searched: true, found: kbFound, sources: [] } } : {}),
      });
    }
  }
  return rows;
}

function verdictFor(runs, options, aborted = null) {
  const rows = rowsFor(runs, options);
  return judge({ perPrompt: summarisePrompts(STEPS, rows), rows, runs, mustNotBlock: MUST, citedStep: 'deciding', aborted });
}

test('it passes only when nothing critical is blocked and every "still deciding" reply cites the window', () => {
  assert.equal(verdictFor(5).pass, true);
  assert.equal(verdictFor(5, { blocked: { '50off': [3] } }).pass, false, 'one block on 50% off');
  assert.equal(verdictFor(5, { blocked: { deciding: [2] } }).pass, false, 'one block on still deciding');
  assert.equal(verdictFor(5, { cited: false }).pass, false, 'replies that never state the window');
  assert.equal(verdictFor(5, { kbFound: false }).pass, false, 'a reply cannot cite a policy that was never found');
  assert.equal(verdictFor(5, { drop: { take: 4, step: '50off' } }).pass, false, 'a critical prompt that got no answer');
});

test('a run that was stopped never passes, however clean the rows before the stop', () => {
  assert.equal(verdictFor(5, {}, { kind: 'knowledge_base' }).pass, false);
  assert.equal(verdictFor(5, {}, { kind: 'outage' }).pass, false);
});

test('the counts the verdict reports are the ones in the rows', () => {
  const v = verdictFor(5, { blocked: { '50off': [1], deciding: [] } });
  assert.deepEqual([v.criticalAnswered, v.criticalBlocked, v.citedReturnPolicy, v.takes], [10, 1, 5, 5]);
});

// --- chat result and the script ----------------------------------------------------------------------------------

test('handleChat hands back what each tool returned, beside the body and not in it', async () => {
  const store = createConversationStore(createDb(':memory:'));
  const toolResults = [found];
  const result = await handleChat(
    { sessionId: 's', message: 'what is the return policy?' },
    { conversationStore: store, generateReply: async () => ({ text: 'Returns are accepted within 30 days.', toolsUsed: ['searchKnowledgeBase'], toolResults }) }
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.toolResults, toolResults);
  assert.ok(!('toolResults' in result.body));
});

test('the rehearsal script starts the same stack as npm run live, and treats a broken knowledge base as an error', () => {
  const source = fs.readFileSync(path.join(serverDir, 'scripts/video-rehearsal.js'), 'utf8');
  assert.match(source, /ensureKnowledgeBase\(\{ config, tag: 'rehearsal' \}\)/);
  assert.match(source, /from '\.\/lib\/stack\.js'/);
  assert.match(source, /knowledgeBaseProblem\(result\.toolResults, captured\)/);
  assert.match(source, /break outer;/);
  assert.match(source, /aborted\?\.kind === 'knowledge_base' \? 3/);
  const stack = fs.readFileSync(path.join(serverDir, 'scripts/lib/stack.js'), 'utf8');
  assert.match(stack, /export async function ensureKnowledgeBase/);
  assert.match(stack, /const knowledgeBase = await ensureKnowledgeBase\(\{ config, tag \}\)/, 'npm run live uses the very same function');
});

// A fake key and a Chroma address that is not local and does not exist: the script must stop before
// any model call, say why, and exit 1. Variables already set in the environment win over .env, so
// this never touches a real key.
test('the rehearsal refuses to start, with no model call, when Chroma is not there', () => {
  const result = spawnSync(process.execPath, ['scripts/video-rehearsal.js', '--runs=1'], {
    cwd: serverDir,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      LLM_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'AQ.fake-key-for-test',
      CHROMA_HOST: 'chroma.invalid',
      CHROMA_PORT: '8000',
      CHROMA_SSL: 'false',
    },
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Chroma is not available, so the knowledge base is not\. Not starting: no model call was made\./);
  assert.ok(!/AQ\.fake-key/.test(result.stdout + result.stderr));
  assert.ok(!/model usage/.test(result.stdout), 'no model was called');
});

// --- the trace is checked against what the same turn produced by other routes ----------------------------

function scripted(script) {
  return {
    async generateReply({ executeTool }) {
      let i = 0;
      return runToolLoop({
        initialState: null,
        callModel: async () => {
          const entry = script[i++];
          const usage = { inputTokens: 10, outputTokens: 2, latencyMs: 4 };
          return entry.calls ? { text: '', functionCalls: entry.calls, usage } : { text: entry.text, functionCalls: [], usage };
        },
        appendToolExchange: (state) => state,
        executeTool,
      });
    },
  };
}

async function turn(message, script) {
  return handleChat(
    { sessionId: 's', message },
    {
      conversationStore: createConversationStore(createDb(':memory:')),
      generateReply: (a) => generateReply(a, { provider: scripted(script), tools: businessTools, providerName: 'scripted', modelId: 'm' }),
    }
  );
}
const policyNames = POLICIES.map((p) => p.name);

test('a trace that agrees with the turn has no problems', async () => {
  const clean = await turn('order 1001 status', [{ calls: [{ name: 'getOrderStatus', args: { orderId: '1001' } }] }, { text: 'Shipped.' }]);
  assert.deepEqual(traceProblems(clean, { policyNames }), []);

  const blocked = await turn('hello', [{ text: "I'll refund you right away!" }]);
  assert.equal(blocked.guardrail.safe, false);
  assert.deepEqual(traceProblems(blocked, { policyNames }), []);
});

test('each way a trace can disagree with the turn is reported', async () => {
  const good = await turn('order 1001 status', [{ calls: [{ name: 'getOrderStatus', args: { orderId: '1001' } }] }, { text: 'Shipped.' }]);
  const withTrace = (mutate) => {
    const copy = structuredClone({ body: good.body, usage: good.usage, guardrail: good.guardrail });
    mutate(copy);
    return traceProblems(copy, { policyNames, secrets: ['SECRET-KEY-VALUE'] });
  };

  assert.deepEqual(traceProblems({ body: {} }, {}), ['the reply has no trace']);
  assert.match(withTrace((t) => { t.body.trace.steps = t.body.trace.steps.filter((s) => s.type !== 'tool'); })[0], /tool steps/);
  assert.match(withTrace((t) => { t.body.toolsUsed = []; })[0], /tool steps/);
  assert.ok(withTrace((t) => { t.usage.calls = 5; }).some((p) => /model step/.test(p)));
  assert.ok(withTrace((t) => { t.body.signals = [{ type: 'price_concern' }]; }).some((p) => /signal steps/.test(p)));
  assert.ok(withTrace((t) => { t.body.trace.steps = t.body.trace.steps.slice(0, -1); }).some((p) => /one per policy/.test(p)));
  assert.ok(withTrace((t) => { t.guardrail.safe = false; }).some((p) => /disagree with the guardrail verdict/.test(p)));
  assert.ok(withTrace((t) => { t.body.trace.steps.push({ type: 'model' }); }).some((p) => /follows the guardrail/.test(p)));
  assert.ok(withTrace((t) => { t.body.trace.steps[0].summary = 'leaked SECRET-KEY-VALUE'; }).some((p) => /secret/.test(p)));
  assert.ok(withTrace((t) => { t.body.trace.totalMs = 'x'; }).some((p) => /totalMs/.test(p)));
});

test('the request budget: a prompt is sent only if two more model requests still fit, and no budget means no limit', () => {
  assert.equal(withinBudget(0, 10), true);
  assert.equal(withinBudget(8, 10), true);
  assert.equal(withinBudget(9, 10), false);
  assert.equal(withinBudget(10, 10), false);
  assert.equal(withinBudget(500, null), true);
  assert.equal(withinBudget(500, undefined), true);
});
