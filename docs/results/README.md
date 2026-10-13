# Recorded real-model runs

Every file here is the output of a run against a real model, saved by the script that made it.
Each records its date, the provider and model ID, and (for evaluations) the dataset version. API
keys are never written: the scripts redact the key from anything they print or save. Nothing here
is edited by hand.

| File | Made by | What it is |
|---|---|---|
| `YYYY-MM-DD-smoke-<model>.json` | `npm run smoke -- --save` | One question through the whole flow: model reachable, a tool called, tokens and latency |
| `YYYY-MM-DD-eval-real-<model>-dataset-<v>.json` | `npm run eval:record` | A full real evaluation run: every reply, tool list, signal, check, tokens and latency |
| `YYYY-MM-DD-eval-regrade-<model>-dataset-<v>.json` | `node scripts/eval.js --regrade=<file> --record` | The saved replies of an earlier run graded again by the current dataset and grader. No model is called, and the replies are unchanged |
| `YYYY-MM-DD-judge-<model>-dataset-<v>.json` | `eval.js --judge-from=<file> --record` | The LLM judge's verdict on each saved reply. Subjective; not part of any score |
| `YYYY-MM-DD-guardrail-drafts-<model>.json` | `guardrail-fp.js --capture --record` | Every dataset case and benign prompt run on the real model, with the model's DRAFT, the policies that fired and the final reply |
| `YYYY-MM-DD-guardrail-labels*.json` | by hand | For each draft, whether it actually broke a rule, with the reason |
| `YYYY-MM-DD-guardrail-analysis-<model>*.json` | `guardrail-fp.js --analyze --record` | False-positive and false-negative rates of the guardrails against the labels, before and after a change |
| `YYYY-MM-DD-rate-limit-probe-<model>.json` | `rate-limit-probe.js --record` | A controlled burst: what the free tier did and what the adapter did about it |
| `YYYY-MM-DD-injection-run-<model>.json`, `*-injection-review.json` | `guardrail-fp.js --capture --prompts=eval/injection-prompts.json --name=injection-run` | Ten injection attempts on the real model, and a hand verdict on each |
| `YYYY-MM-DD-summary.md` | by hand | What the runs of that day add up to |

Mock-mode evaluation output is **not** kept here: it replays scripted answers and says nothing
about a model.
