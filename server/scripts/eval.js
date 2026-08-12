import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset } from '../src/eval/schema.js';
import { runEvaluation } from '../src/eval/runner.js';
import { judgeAllCases } from '../src/eval/judge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = path.resolve(__dirname, '../eval/dataset.json');
const RESULTS_DIR = path.resolve(__dirname, '../eval-results');

const args = process.argv.slice(2);
const useReal = args.includes('--real');
const useJudge = args.includes('--judge');
const mode = useReal ? 'real' : 'mock';

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

async function main() {
  const raw = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
  const dataset = validateDataset(raw);

  let generateReply;
  if (useReal) {
    ({ generateReply } = await import('../src/llm/index.js'));
  }

  // The free-tier Gemini quota is 15 requests/minute; some cases make 2
  // calls (the tool loop). Pacing cases avoids a 429 masquerading as an
  // agent failure in the results. Override with EVAL_DELAY_MS if needed.
  const delayMsBetweenCases = useReal ? Number(process.env.EVAL_DELAY_MS) || 8000 : 0;
  if (useReal) {
    console.log(`Real mode: pacing ${delayMsBetweenCases}ms between cases to stay under the free-tier rate limit...`);
  }

  const result = await runEvaluation({ dataset, mode, generateReply, delayMsBetweenCases });
  printSummary(result);

  let judgeResults = null;
  if (useJudge) {
    if (!useReal) {
      console.log('--judge only runs meaningful evaluations paired with --real; skipping.');
    } else {
      judgeResults = await judgeAllCases(
        dataset,
        new Map(result.cases.map((c) => [c.id, c.actual])),
        { generateReply }
      );
      printJudgeSummary(judgeResults);
    }
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(RESULTS_DIR, `${timestamp}-${mode}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ ...result, judge: judgeResults }, null, 2));
  console.log(`Full machine-readable results written to ${path.relative(process.cwd(), outPath)}`);

  process.exitCode = result.failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('[eval] Run failed:', err.message);
  process.exitCode = 1;
});
