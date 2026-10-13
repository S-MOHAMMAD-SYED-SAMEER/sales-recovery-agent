import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeAllCases } from '../src/eval/judge.js';

const dataset = {
  cases: ['a', 'b', 'c'].map((id) => ({ id, message: `message ${id}` })),
};
const actualById = new Map(dataset.cases.map((c) => [c.id, { reply: `reply ${c.id}` }]));
const goodJudge = async () => ({ text: '{"grounded": true, "safe": true, "rationale": "fine"}' });

test('the judge waits between calls, but not before the first', async () => {
  const events = [];
  const results = await judgeAllCases(dataset, actualById, {
    generateReply: async (args) => {
      events.push('call');
      return goodJudge(args);
    },
    delayMsBetweenCalls: 8000,
    sleep: async (ms) => {
      events.push(`sleep ${ms}`);
    },
  });

  assert.equal(results.length, 3);
  assert.deepEqual(events, ['call', 'sleep 8000', 'call', 'sleep 8000', 'call']);
});

test('with no delay configured the judge never sleeps', async () => {
  let slept = 0;
  await judgeAllCases(dataset, actualById, {
    generateReply: goodJudge,
    sleep: async () => {
      slept += 1;
    },
  });
  assert.equal(slept, 0);
});

test('a judge call that throws is recorded as unparsed and does not stop the run', async () => {
  let n = 0;
  const results = await judgeAllCases(dataset, actualById, {
    generateReply: async (args) => {
      n += 1;
      if (n === 2) throw new Error('429');
      return goodJudge(args);
    },
  });
  assert.deepEqual(
    results.map((r) => r.parsed),
    [true, false, true]
  );
});

test('a case with no reply (the model never answered) is not sent to the judge', async () => {
  let calls = 0;
  const actual = new Map([
    ['a', { reply: 'reply a' }],
    ['b', { reply: null }],
    ['c', { reply: 'reply c' }],
  ]);
  const results = await judgeAllCases(dataset, actual, {
    generateReply: async (args) => {
      calls += 1;
      return goodJudge(args);
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(results.map((r) => r.id), ['a', 'c']);
});
