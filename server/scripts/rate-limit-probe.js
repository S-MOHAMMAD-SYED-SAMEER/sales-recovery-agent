// A controlled burst, to see what the Gemini adapter does when the free tier says no.
//
//   node scripts/rate-limit-probe.js [--requests=20] [--record]
//
// It fires N tiny requests (16 output tokens, no tools) all at once through the real
// adapter, with its normal timeout and retry settings, and records for each request
// whether it succeeded, how many attempts it took, how long it took, and what a
// failure said. Each failed attempt may be retried up to LLM_MAX_RETRIES times
// (default 2) so the worst case is N x 3 attempts. It makes no further attempts:
// whatever the adapter could not clear is reported, not retried here.
//
// What it answers: does a 429 actually occur at this burst size, does the adapter
// honour the server's requested wait, and does it give up cleanly when that wait is
// too long. The key is redacted from everything printed or saved.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { config } from '../src/config/env.js';
import { createGeminiProvider } from '../src/llm/providers/gemini.js';
import { requestedDelayMs } from '../src/llm/resilience.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const requests = Number((args.find((a) => a.startsWith('--requests=')) || '--requests=20').split('=')[1]);
const record = args.includes('--record');

if (config.llmProvider !== 'gemini' || !config.geminiApiKey) {
  console.error('LLM_PROVIDER must be gemini with GEMINI_API_KEY set.');
  process.exit(1);
}
if (!Number.isInteger(requests) || requests < 1 || requests > 30) {
  console.error('--requests must be an integer from 1 to 30 (a burst, not a load test).');
  process.exit(1);
}

const secret = config.geminiApiKey;
const redact = (text) => String(text).split(secret).join('[redacted]');

const retryLog = [];
const collector = { warn: (m) => retryLog.push(redact(m)), error: (m) => retryLog.push(redact(m)), log: () => {} };

const { generateReply } = createGeminiProvider({
  client: new GoogleGenAI({ apiKey: secret }),
  model: config.geminiModel,
  timeoutMs: config.llmTimeoutMs,
  maxRetries: config.llmMaxRetries,
  maxOutputTokens: 16,
  temperature: 1.0,
  log: collector,
});

console.log(`Burst of ${requests} concurrent requests to ${config.geminiModel} (timeout ${config.llmTimeoutMs}ms, up to ${config.llmMaxRetries} retries each).`);
const started = Date.now();
const settled = await Promise.allSettled(
  Array.from({ length: requests }, (_, i) =>
    generateReply({
      systemPrompt: 'Reply with one short word.',
      messages: [{ role: 'user', content: `Say hello (${i + 1}).` }],
      tools: [],
      executeTool: async () => ({ ok: false, error: 'no tools' }),
    })
  )
);
const elapsedMs = Date.now() - started;

const rows = settled.map((s, i) => {
  if (s.status === 'fulfilled') {
    const call = s.value.usage?.perCall?.[0];
    return { n: i + 1, ok: true, attempts: call?.attempts ?? 1, latencyMs: Math.round(call?.latencyMs ?? 0), totalTokens: call?.totalTokens ?? null };
  }
  const message = redact(s.reason?.message ?? String(s.reason));
  return {
    n: i + 1,
    ok: false,
    status: s.reason?.status ?? null,
    requestedWaitMs: requestedDelayMs(s.reason) ?? null,
    error: message.length > 400 ? `${message.slice(0, 400)}…` : message,
  };
});

const ok = rows.filter((r) => r.ok);
const failed = rows.filter((r) => !r.ok);
const retried = ok.filter((r) => r.attempts > 1);
const summary = {
  requests,
  succeeded: ok.length,
  succeededFirstTry: ok.filter((r) => r.attempts === 1).length,
  succeededAfterRetry: retried.length,
  failedAfterRetries: failed.length,
  failureStatuses: [...new Set(failed.map((r) => r.status))],
  retryMessages: retryLog.length,
  elapsedMs,
};
console.log(JSON.stringify(summary));
for (const line of retryLog.slice(0, 12)) console.log(`  ${line}`);
if (retryLog.length > 12) console.log(`  … and ${retryLog.length - 12} more`);
for (const r of failed.slice(0, 5)) console.log(`  FAILED #${r.n}: status ${r.status}, server asked for ${r.requestedWaitMs ?? '?'}ms: ${r.error.slice(0, 160)}`);

if (record) {
  const dir = path.resolve(__dirname, '../../docs/results');
  fs.mkdirSync(dir, { recursive: true });
  const model = config.geminiModel.replace(/[^A-Za-z0-9.-]/g, '_');
  let file = path.join(dir, `${new Date().toISOString().slice(0, 10)}-rate-limit-probe-${model}.json`);
  for (let i = 2; fs.existsSync(file); i += 1) file = file.replace(/(-\d+)?\.json$/, `-${i}.json`);
  const out = { meta: { date: new Date().toISOString(), provider: 'gemini', model: config.geminiModel, requests, timeoutMs: config.llmTimeoutMs, maxRetries: config.llmMaxRetries, maxOutputTokens: 16 }, summary, retryLog, requests: rows };
  fs.writeFileSync(file, redact(JSON.stringify(out, null, 2)) + '\n');
  console.log(`Recorded ${path.relative(process.cwd(), file)}`);
}
process.exitCode = failed.length > 0 ? 2 : 0;
