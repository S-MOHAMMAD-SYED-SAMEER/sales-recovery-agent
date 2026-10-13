# Recorded real-model runs

Every file here is the output of a run against a real model, saved by the script that made it.
Each records its date, the provider and model ID, and (for evaluations) the dataset version. API
keys are never written: the scripts redact the key from anything they print or save. Nothing here
is edited by hand.

| File | Made by | What it is |
|---|---|---|
| `YYYY-MM-DD-smoke-<model>.json` | `npm run smoke -- --save` | One question through the whole flow: model reachable, a tool called, tokens and latency |

Mock-mode evaluation output is **not** kept here: it replays scripted answers and says nothing
about a model.
