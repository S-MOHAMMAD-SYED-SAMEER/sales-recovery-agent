import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset } from '../src/eval/schema.js';
import { runEvaluation } from '../src/eval/runner.js';
import { judgeAllCases } from '../src/eval/judge.js';
import { formatUsage } from '../src/llm/usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = path.resolve(__dirname, '../eval/dataset.json');
const RESULTS_DIR = path.resolve(__dirname, '../eval-results');

const RECORD_DIR = path.resolve(__dirname, '../../docs/results');

const args = process.argv.slice(2);
const useReal = args.includes('--real');
const useJudge = args.includes('--judge');
// --record: also save a real run under docs/results/ with its date, provider,
//   model and dataset version, for the repo to keep.
// --judge-from=<results.json>: grade the replies saved by an earlier real run
//   with the judge, without re-running the cases (so no case calls are spent
//   twice). Implies --real for the judge's own calls.
const record = args.includes('--record');
// --regrade=<results.json>: grade the replies an earlier real run saved against the
//   current dataset and grader. No model is called, so it costs nothing; it is how a
//   grader false negative is corrected without re-spending the calls.
const regradeArg = args.find((a) => a.startsWith('--regrade='));
const regradeFrom = regradeArg ? regradeArg.slice('--regrade='.length) : null;
const judgeFromArg = args.find((a) => a.startsWith('--judge-from='));
const judgeFrom = judgeFromArg ? judgeFromArg.slice('--judge-from='.length) : null;
const mode = useReal || judgeFrom || regradeFrom ? 'real' : 'mock';

function pct(ratio) {
  if (!ratio || ratio.value === null) return 'n/a (0 applicable cases)';
  return `${(ratio.value * 100).toFixed(1)}% (${ratio.numerator}/${ratio.denominator})`;
}

function printSummary(result) {
  console.log('');
  console.log(`Sales-Recovery Agent — evaluation (${result.mode} mode, dataset v${result.datasetVersion})`);
  console.log('='.repeat(70));
  console.log(`Total cases:  ${result.totalCases}`);
  console.log(`Passed:       ${result.passed}`);
  console.log(`Failed:       ${result.failed}`);
  console.log(`Pass rate:    ${(result.passRate * 100).toFixed(1)}%`);
  console.log('');
  console.log('Deterministic metrics (ground truth from the dataset, not an LLM opinion):');
  console.log(`  Tool-selection accuracy:      ${pct(result.metrics.toolSelectionAccuracy)}`);
  console.log(`  Signal-detection accuracy:    ${pct(result.metrics.signalDetectionAccuracy)}`);
  console.log(`  Grounded-answer accuracy:     ${pct(result.metrics.groundedAnswerAccuracy)}`);
  console.log(`  Unsupported-answer accuracy:  ${pct(result.metrics.unsupportedAnswerAccuracy)}`);
  console.log(`  Guardrail/safety pass rate:   ${pct(result.metrics.guardrailSafetyPassRate)}`);
  console.log(`  Hallucination rate:           ${pct(result.metrics.hallucinationRate)}`);
  console.log('');
  if (result.usage) {
    console.log('Model usage (tokens as the provider reports them):');
    console.log(`  ${formatUsage(result.usage)}`);
    console.log('');
  }

  const failures = result.cases.filter((c) => !c.passed);
  if (failures.length > 0) {
    console.log('Failed cases:');
    for (const c of failures) {
      console.log(`  ✗ ${c.id} (${c.category})${c.error ? ` — error: ${c.error}` : ''}`);
      for (const [checkName, check] of Object.entries(c.checks)) {
        if (check.applicable && !check.passed) {
          console.log(`      - ${checkName}: expected=${JSON.stringify(check.expected)} actual=${JSON.stringify(check.actual)}`);
        }
      }
    }
    console.log('');
  }
}

function printJudgeSummary(judgeResults) {
  console.log('LLM-judge results (SUBJECTIVE — a second opinion, not ground truth, not part of the metrics above):');
  const parsed = judgeResults.filter((r) => r.parsed);
  const groundedYes = parsed.filter((r) => r.grounded).length;
  const safeYes = parsed.filter((r) => r.safe).length;
  console.log(`  Judge-parsed responses: ${parsed.length}/${judgeResults.length}`);
  if (parsed.length > 0) {
    console.log(`  Judge says "grounded": ${groundedYes}/${parsed.length}`);
    console.log(`  Judge says "safe":     ${safeYes}/${parsed.length}`);
  }
  for (const r of judgeResults) {
    if (!r.parsed) {
      console.log(`  ⚠ ${r.id}: judge response could not be parsed${r.error ? ` (${r.error})` : ''}`);
    }
  }
  console.log('');
}

// Every string written to disk or the terminal below goes through this, so a key
// can never end up in a recorded result even if a provider error echoed it.
function redactSecrets(text, secrets) {
  let out = text;
  for (const secret of secrets.filter(Boolean)) out = out.split(secret).join('[redacted]');
  return out;
}

function recordedPath(kind, model, datasetVersion) {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const safeModel = model.replace(/[^A-Za-z0-9.-]/g, '_');
  const base = `${date}-${kind}-${safeModel}-dataset-${datasetVersion}`;
  let candidate = path.join(RECORD_DIR, `${base}.json`);
  for (let i = 2; fs.existsSync(candidate); i += 1) candidate = path.join(RECORD_DIR, `${base}-${i}.json`);
  return candidate;
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
  const dataset = validateDataset(raw);

  if (regradeFrom) {
    let prior = JSON.parse(fs.readFileSync(path.resolve(regradeFrom), 'utf-8'));
    // A guardrail capture (scripts/guardrail-fp.js) also holds a real reply for every
    // dataset case: that is a second, independent real run, and can be graded the same way.
    if (prior.prompts && !prior.cases) {
      prior = {
        ...prior,
        datasetVersion: prior.meta?.datasetVersion,
        cases: prior.prompts
          .filter((p) => p.set === 'dataset')
          .map((p) => ({
            id: p.id,
            actual: p.status === 200 ? { reply: p.finalReply, toolsUsed: p.toolsUsed, signals: p.signals.map((type) => ({ type })) } : null,
            usage: p.usage ?? null,
            providerError: p.status !== 200,
            passed: false,
            checks: {},
            hallucination: { checked: false, hallucinated: false },
          })),
      };
    }
    const { evaluateCase, aggregateMetrics } = await import('../src/eval/metrics.js');
    const { combineUsage } = await import('../src/llm/usage.js');
    const graded = [];
    for (const evalCase of dataset.cases) {
      const old = prior.cases.find((c) => c.id === evalCase.id);
      if (!old) continue; // a case added since that run has no saved reply
      graded.push(old.actual?.reply ? { ...evaluateCase(evalCase, old.actual), usage: old.usage ?? null } : old);
    }
    const result = {
      datasetVersion: dataset.version,
      mode: 'real',
      ...aggregateMetrics(graded),
      usage: combineUsage(graded.map((c) => c.usage)),
      aborted: prior.aborted ?? null,
      cases: graded,
    };
    console.log(`Re-grading ${graded.length} saved replies from the run of ${prior.meta?.date ?? 'unknown date'} (${prior.meta?.model ?? 'unknown model'}, dataset ${prior.datasetVersion}) against dataset ${dataset.version}. No model is called.`);
    printSummary(result);
    const out = {
      meta: {
        ...(prior.meta ?? {}),
        regradedFrom: path.basename(regradeFrom),
        regradedAt: new Date().toISOString(),
        originalDatasetVersion: prior.datasetVersion,
        datasetVersion: dataset.version,
        note: 'The saved replies are unchanged; only the dataset and grader differ from the original run. Usage is the original run\'s.',
      },
      ...result,
    };
    if (record) {
      const model = prior.meta?.model ?? 'unknown-model';
      const outPath = recordedPath('eval-regrade', model, dataset.version);
      fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
      console.log(`Recorded ${path.relative(process.cwd(), outPath)}`);
    }
    process.exitCode = result.failed > 0 ? 1 : 0;
    return;
  }

  let generateReply;
  let runMeta = null;
  let secrets = [];
  if (mode === 'real') {
    ({ generateReply } = await import('../src/llm/index.js'));
    const { config } = await import('../src/config/env.js');
    secrets = [config.geminiApiKey, config.anthropicApiKey];
    runMeta = {
      date: new Date().toISOString(),
      provider: config.llmProvider,
      model: config.llmProvider === 'gemini' ? config.geminiModel : config.anthropicModel,
      datasetVersion: dataset.version,
    };
  }

  // Some free tiers cap requests per minute (the figure for the current
  // Gemini model is not published), and some cases make 2 calls (the tool
  // loop). Pacing cases, and the judge's calls after them, avoids a 429
  // masquerading as an agent failure in the results. Override with
  // EVAL_DELAY_MS if needed.
  const delayMsBetweenCases = mode === 'real' ? Number(process.env.EVAL_DELAY_MS) || 8000 : 0;
  if (mode === 'real') {
    console.log(`Real mode (${runMeta.provider}, ${runMeta.model}): pacing ${delayMsBetweenCases}ms between calls to stay under the free-tier rate limit...`);
    runMeta.delayMsBetweenCases = delayMsBetweenCases;
  }

  // Judge-only: grade the saved replies of an earlier run; no case is re-run.
  if (judgeFrom) {
    const prior = JSON.parse(fs.readFileSync(path.resolve(judgeFrom), 'utf-8'));
    const replies = new Map(prior.cases.filter((c) => c.actual?.reply).map((c) => [c.id, c.actual]));
    console.log(`Judging ${replies.size} saved replies from ${path.basename(judgeFrom)} (run of ${prior.meta?.date ?? 'unknown date'}).`);
    const judgeResults = await judgeAllCases(dataset, replies, { generateReply, delayMsBetweenCalls: delayMsBetweenCases });
    printJudgeSummary(judgeResults);
    const out = { meta: { ...runMeta, judgedRun: path.basename(judgeFrom) }, judge: judgeResults };
    if (record) {
      const outPath = recordedPath('judge', runMeta.model, dataset.version);
      fs.writeFileSync(outPath, redactSecrets(JSON.stringify(out, null, 2), secrets) + '\n');
      console.log(`Recorded ${path.relative(process.cwd(), outPath)}`);
    }
    return;
  }

  const result = await runEvaluation({
    dataset,
    mode,
    generateReply,
    delayMsBetweenCases,
    // A quota or outage that retries could not clear will not clear on the next
    // case either: stop instead of spending more calls.
    maxConsecutiveProviderErrors: mode === 'real' ? 2 : 0,
  });
  printSummary(result);
  if (result.aborted) {
    console.log(`RUN STOPPED EARLY: ${result.aborted.reason}`);
    console.log(`  Last case: ${result.aborted.lastCase} (${result.aborted.lastError}); ${result.aborted.casesNotRun} case(s) not run.`);
    console.log('');
  }

  let judgeResults = null;
  if (useJudge) {
    if (mode !== 'real') {
      console.log('--judge only runs meaningful evaluations paired with --real; skipping.');
    } else if (result.aborted) {
      console.log('--judge skipped because the run stopped early.');
    } else {
      judgeResults = await judgeAllCases(
        dataset,
        new Map(result.cases.filter((c) => c.actual?.reply).map((c) => [c.id, c.actual])),
        { generateReply, delayMsBetweenCalls: delayMsBetweenCases }
      );
      printJudgeSummary(judgeResults);
    }
  }

  const output = JSON.stringify({ meta: runMeta, ...result, judge: judgeResults }, null, 2);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(RESULTS_DIR, `${timestamp}-${mode}.json`);
  fs.writeFileSync(outPath, redactSecrets(output, secrets));
  console.log(`Full machine-readable results written to ${path.relative(process.cwd(), outPath)}`);

  if (record && mode === 'real') {
    const recorded = recordedPath('eval-real', runMeta.model, dataset.version);
    fs.writeFileSync(recorded, redactSecrets(output, secrets) + '\n');
    console.log(`Recorded ${path.relative(process.cwd(), recorded)}`);
  }

  process.exitCode = result.aborted ? 2 : result.failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('[eval] Run failed:', err.message);
  process.exitCode = 1;
});
