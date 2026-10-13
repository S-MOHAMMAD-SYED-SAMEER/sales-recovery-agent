// Measures how often the guardrails block a reply that was fine.
//
// A guardrail that blocks a bad reply is working; one that blocks a good reply
// replaces a useful answer with "I'm not confident that answer is correct", which
// for a support bot is a failure of its own. The only way to tell them apart is to
// look at what the model actually drafted, so this script keeps the draft.
//
//   node scripts/guardrail-fp.js --capture          real model: runs every dataset case
//                                                   and every benign prompt, paced, and
//                                                   saves each DRAFT with the policies
//                                                   that fired. Makes about 1-2 calls per
//                                                   prompt.
//   node scripts/guardrail-fp.js --analyze=<drafts.json> --labels=<labels.json>
//                                                   no model: runs the CURRENT guardrails
//                                                   over the saved drafts and compares
//                                                   with the hand labels. Free, repeatable;
//                                                   this is how a policy fix is measured
//                                                   on the same drafts, before and after.
//
// Add --record to save the output under docs/results/. The key is redacted from
// everything written.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset } from '../src/eval/schema.js';
import { validateReply } from '../src/guardrails/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = path.resolve(__dirname, '../eval/dataset.json');
const BENIGN_PATH = path.resolve(__dirname, '../eval/benign-prompts.json');
const RECORD_DIR = path.resolve(__dirname, '../../docs/results');

const args = process.argv.slice(2);
const record = args.includes('--record');
const capture = args.includes('--capture');
// --prompts=<file>: capture only the prompts in that file ({ version, prompts: [{ id, message }] })
// instead of the dataset plus the benign set. Used for a held-out check of a fix.
const promptsArg = args.find((a) => a.startsWith('--prompts='));
const analyzeArg = args.find((a) => a.startsWith('--analyze='));
const labelsArg = args.find((a) => a.startsWith('--labels='));

function recordedPath(kind, model) {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const base = `${new Date().toISOString().slice(0, 10)}-${kind}-${model.replace(/[^A-Za-z0-9.-]/g, '_')}`;
  let candidate = path.join(RECORD_DIR, `${base}.json`);
  for (let i = 2; fs.existsSync(candidate); i += 1) candidate = path.join(RECORD_DIR, `${base}-${i}.json`);
  return candidate;
}

function loadPrompts() {
  if (promptsArg) {
    const file = path.resolve(promptsArg.slice('--prompts='.length));
    const extra = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      datasetVersion: null,
      benignVersion: null,
      promptsFile: { name: path.basename(file), version: extra.version },
      prompts: extra.prompts.map((p) => ({ id: p.id, set: path.basename(file, '.json'), category: 'heldout', message: p.message, priorTurns: [] })),
    };
  }
  const dataset = validateDataset(JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8')));
  const benign = JSON.parse(fs.readFileSync(BENIGN_PATH, 'utf-8'));
  return {
    datasetVersion: dataset.version,
    benignVersion: benign.version,
    prompts: [
      ...dataset.cases.map((c) => ({ id: c.id, set: 'dataset', category: c.category, message: c.message, priorTurns: c.priorTurns || [] })),
      ...benign.prompts.map((p) => ({ id: p.id, set: 'benign', category: 'benign', message: p.message, priorTurns: [] })),
    ],
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCapture() {
  const { config } = await import('../src/config/env.js');
  const { handleChat } = await import('../src/routes/chat.js');
  const { createDb } = await import('../src/memory/db.js');
  const { createConversationStore } = await import('../src/memory/conversationStore.js');
  if (config.llmProvider === 'demo' || (config.llmProvider === 'gemini' && !config.geminiApiKey) || (config.llmProvider === 'anthropic' && !config.anthropicApiKey)) {
    console.error('A real provider with its key is needed (see server/.env.example).');
    process.exit(1);
  }
  const secrets = [config.geminiApiKey, config.anthropicApiKey].filter(Boolean);
  const model = config.llmProvider === 'gemini' ? config.geminiModel : config.anthropicModel;
  const delay = Number(process.env.EVAL_DELAY_MS) || 8000;
  const { prompts, datasetVersion, benignVersion, promptsFile } = loadPrompts();
  console.log(`Capturing ${prompts.length} prompts from ${config.llmProvider} ${model}, ${delay}ms apart.`);

  const out = [];
  let consecutiveFailures = 0;
  let aborted = null;
  for (const [i, p] of prompts.entries()) {
    if (i > 0) await sleep(delay);
    const store = createConversationStore(createDb(':memory:'));
    for (const turn of p.priorTurns) store.saveMessage(p.id, turn.role, turn.content);
    const result = await handleChat({ sessionId: p.id, message: p.message }, { conversationStore: store });
    const entry = { id: p.id, set: p.set, category: p.category, message: p.message, status: result.status };
    if (result.status === 200) {
      entry.draft = result.guardrail.draft;
      entry.violations = result.guardrail.violations;
      entry.finalReply = result.body.reply;
      entry.toolsUsed = result.body.toolsUsed;
      entry.signals = result.body.signals.map((s) => s.type);
      entry.usage = result.usage ? { calls: result.usage.calls, totalTokens: result.usage.totalTokens, latencyMs: result.usage.latencyMs } : null;
      consecutiveFailures = 0;
    } else {
      entry.error = result.body?.error;
      consecutiveFailures += 1;
    }
    out.push(entry);
    console.log(`${String(i + 1).padStart(2)}/${prompts.length} ${p.id}: ${result.status === 200 ? (entry.violations.length ? `BLOCKED by ${entry.violations.map((v) => v.name).join(', ')}` : 'ok') : `no answer (${result.status})`}`);
    if (consecutiveFailures >= 2 && i < prompts.length - 1) {
      aborted = { reason: '2 prompts in a row got no answer from the model; stopped so as not to keep spending calls.', lastPrompt: p.id, promptsNotRun: prompts.length - i - 1 };
      console.log(`STOPPED EARLY: ${aborted.reason}`);
      break;
    }
  }

  const calls = out.reduce((n, e) => n + (e.usage?.calls ?? 0), 0);
  let json = JSON.stringify({ meta: { date: new Date().toISOString(), provider: config.llmProvider, model, datasetVersion, benignPromptsVersion: benignVersion, promptsFile: promptsFile ?? null, delayMs: delay, modelCalls: calls }, aborted, prompts: out }, null, 2);
  for (const secret of secrets) json = json.split(secret).join('[redacted]');
  if (record) {
    const file = recordedPath('guardrail-drafts', model);
    fs.writeFileSync(file, json + '\n');
    console.log(`Recorded ${path.relative(process.cwd(), file)}`);
  }
  process.exitCode = aborted ? 2 : 0;
}

function pct(n, d) {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}% (${n}/${d})`;
}

function runAnalyze() {
  const saved = JSON.parse(fs.readFileSync(path.resolve(analyzeArg.slice('--analyze='.length)), 'utf-8'));
  const labels = labelsArg ? JSON.parse(fs.readFileSync(path.resolve(labelsArg.slice('--labels='.length)), 'utf-8')) : null;
  const answered = saved.prompts.filter((p) => p.status === 200);

  const rows = answered.map((p) => {
    const now = validateReply({ reply: p.draft, toolsUsed: p.toolsUsed });
    return {
      id: p.id,
      set: p.set,
      blockedAtCapture: p.violations.length > 0,
      policiesAtCapture: p.violations.map((v) => v.name),
      blockedNow: !now.safe,
      policiesNow: now.violations.map((v) => v.name),
      violates: labels ? labels.labels[p.id]?.violates ?? null : null,
    };
  });

  const summarize = (key) => {
    const blocked = rows.filter((r) => r[key]);
    const out = { drafts: rows.length, blocked: blocked.length };
    if (labels) {
      const clean = rows.filter((r) => r.violates === false);
      const bad = rows.filter((r) => r.violates === true);
      out.falsePositives = rows.filter((r) => r[key] && r.violates === false).map((r) => r.id);
      out.falseNegatives = rows.filter((r) => !r[key] && r.violates === true).map((r) => r.id);
      out.falsePositiveRate = pct(out.falsePositives.length, clean.length);
      out.falseNegativeRate = pct(out.falseNegatives.length, bad.length);
      out.unlabelled = rows.filter((r) => r.violates === null).map((r) => r.id);
    }
    return out;
  };

  const result = { source: path.basename(analyzeArg.slice('--analyze='.length)), model: saved.meta?.model, atCapture: summarize('blockedAtCapture'), withCurrentGuardrails: summarize('blockedNow'), rows };
  console.log(`Drafts: ${rows.length} answered of ${saved.prompts.length}.`);
  for (const [label, key] of [['At capture (guardrails as they were)', 'atCapture'], ['Current guardrails', 'withCurrentGuardrails']]) {
    const s = result[key];
    console.log(`\n${label}: blocked ${s.blocked}/${s.drafts}`);
    if (labels) {
      console.log(`  false-positive rate: ${s.falsePositiveRate}   [${s.falsePositives.join(', ') || 'none'}]`);
      console.log(`  false-negative rate: ${s.falseNegativeRate}   [${s.falseNegatives.join(', ') || 'none'}]`);
      if (s.unlabelled.length) console.log(`  UNLABELLED: ${s.unlabelled.join(', ')}`);
    }
  }
  if (record) {
    const file = recordedPath('guardrail-analysis', saved.meta?.model ?? 'unknown-model');
    fs.writeFileSync(file, JSON.stringify({ meta: { analysedAt: new Date().toISOString(), draftsFrom: result.source, labels: labelsArg ? path.basename(labelsArg.slice('--labels='.length)) : null }, ...result }, null, 2) + '\n');
    console.log(`Recorded ${path.relative(process.cwd(), file)}`);
  }
}

if (analyzeArg) runAnalyze();
else if (capture) await runCapture();
else {
  console.error('Use --capture (real model) or --analyze=<drafts.json> [--labels=<labels.json>].');
  process.exitCode = 1;
}
