// One real request through the whole app flow, to confirm the configured model
// ID is valid, tool-calling works, and token usage and latency come back.
//
//   npm run smoke            prints the result
//   npm run smoke -- --save  also writes docs/results/<date>-smoke-<model>.json
//
// It makes 1 metadata request (Gemini only: models.get, which does not use
// generation quota) and 2 generation calls (the model asks for checkStock, then
// writes the answer), plus retries only if a call fails with a 429 or 5xx.
// It reads the key from the environment (server/.env) and never prints it:
// every string that leaves this script is passed through redact().

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isConfigured } from '../src/config/env.js';
import { handleChat } from '../src/routes/chat.js';
import { createDb } from '../src/memory/db.js';
import { createConversationStore } from '../src/memory/conversationStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, '../../docs/results');
const save = process.argv.includes('--save');
const QUESTION = 'Is the Ceramic Mug in stock?';

const secrets = [config.geminiApiKey, config.anthropicApiKey].filter(Boolean);
function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text;
}

if (config.llmProvider === 'demo' || !isConfigured) {
  console.error(
    `LLM_PROVIDER is "${config.llmProvider}" and ${isConfigured ? 'needs no key, so there is nothing to smoke-test.' : 'is missing its key (see server/.env.example).'}`
  );
  process.exit(1);
}

const model = config.llmProvider === 'gemini' ? config.geminiModel : config.anthropicModel;
const record = { date: new Date().toISOString(), provider: config.llmProvider, model, question: QUESTION };

try {
  if (config.llmProvider === 'gemini') {
    const { GoogleGenAI } = await import('@google/genai');
    const info = await new GoogleGenAI({ apiKey: config.geminiApiKey }).models.get({ model });
    record.modelInfo = {
      name: info.name,
      displayName: info.displayName,
      inputTokenLimit: info.inputTokenLimit,
      outputTokenLimit: info.outputTokenLimit,
      supportedActions: info.supportedActions,
    };
    console.log(redact(`Model found: ${JSON.stringify(record.modelInfo)}`));
  }

  const store = createConversationStore(createDb(':memory:'));
  const result = await handleChat({ sessionId: 'smoke', message: QUESTION }, { conversationStore: store });
  record.status = result.status;
  record.reply = result.body.reply ?? null;
  record.error = result.body.error ?? null;
  record.toolsUsed = result.body.toolsUsed ?? null;
  record.signals = result.body.signals ?? null;
  record.usage = result.usage ?? null;
  console.log(redact({ status: record.status, reply: record.reply, error: record.error, toolsUsed: record.toolsUsed }));
  if (record.usage) {
    const { perCall, ...totals } = record.usage;
    console.log(redact({ usage: totals, perCall }));
  }
  record.ok = result.status === 200 && Array.isArray(record.toolsUsed) && record.toolsUsed.includes('checkStock');
} catch (err) {
  record.ok = false;
  record.error = redact(err?.message ?? String(err));
  console.error(`Smoke test failed: ${record.error}`);
}

console.log(record.ok ? 'OK: model reachable, checkStock was called, usage recorded.' : 'NOT OK.');

if (save) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const name = `${record.date.slice(0, 10)}-smoke-${model.replace(/[^A-Za-z0-9.-]/g, '_')}.json`;
  fs.writeFileSync(path.join(RESULTS_DIR, name), redact(record) + '\n');
  console.log(`Saved docs/results/${name}`);
}
process.exitCode = record.ok ? 0 : 1;
