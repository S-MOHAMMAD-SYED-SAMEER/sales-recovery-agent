# Project 1 — Sales-Recovery Support Agent

A case study. Full technical documentation lives in [README.md](./README.md); this is the
condensed version — what problem it solves, how it's built, the decisions behind it, and what it
actually achieves, measured rather than claimed.

**Status: code complete and evaluated on a real model (Gemini); the Anthropic adapter is still unrun.** It runs locally with one
command (see "Run it locally" in the README), on synthetic data and a credential-free demo provider.
There is no real store connected and no payment processing — see "Known limitations" below for the
full list of what this is not, and "Results" for exactly what has and has not been measured.

## Problem

Small international D2C stores lose sales in ways that are easy to overlook because each instance
looks minor: a shipping question that sits unanswered for a day, a return policy that's unclear
enough to make a customer hesitate, a customer who's clearly on the fence in a chat and gets a
generic reply instead of a helpful one. None of these are dramatic individually. Together, over
enough customers, they're a real, quantifiable source of lost revenue — and unlike a redesign or a
marketing campaign, they're addressable with a support experience that's simply faster and more
consistent than a small team can be by hand.

## Solution

An AI support agent that:
1. **Answers policy and product questions accurately**, grounded in the store's actual documented
   policies (shipping, returns, product care, FAQ) — not the model's general knowledge.
2. **Looks up real-time business data on request** — order status, stock, discount validity —
   through explicit tools, never by guessing.
3. **Remembers the conversation** within a session, so it doesn't ask the customer to repeat
   themselves.
4. **Notices a small set of sales-relevant signals** in what the customer says (hesitation, a
   shipping worry, a price concern) and responds a little more proactively when it sees one —
   without ever inventing a discount or promise to do it.
5. **Is constrained, not just prompted, to avoid the failure mode that matters most for a support
   bot**: stating something false about an order, a price, a policy, or making a promise (a refund)
   it has no way to actually fulfill.
6. **Is measured, not just demoed** — a versioned evaluation suite checks all of the above against
   21 representative cases, including injection and refusal attempts, in a scripted mock mode and
   on a real model (two recorded runs on Gemini, below).

## Architecture

```mermaid
flowchart TD
    A[Customer message] --> B[Load conversation history<br/>SQLite]
    B --> C[Detect signals<br/>current message only]
    C --> D[Build system prompt<br/>base + signal directive]
    D --> E[LLM reasoning]
    E -->|needs live data| F[Business tools<br/>order / stock / discount]
    E -->|needs policy/product info| G[RAG retrieval<br/>Chroma + local embeddings]
    F --> E
    G --> E
    E --> H[Draft reply]
    H --> I[Guardrail validation]
    I -->|safe| J[Final reply]
    I -->|unsafe| K[Safe fallback reply]
    K --> J
    J --> L[Persist user + final reply<br/>SQLite]
    L --> M[Response to customer<br/>reply + toolsUsed + signals]
```

**Modules** (`server/src/`), each independently testable and deliberately decoupled from the others:

| Module | Responsibility |
|---|---|
| `llm/` | Provider-agnostic `generateReply()`; Gemini and Anthropic adapters share one tool-calling loop |
| `tools/` | Three mock business tools (order status, stock, discount) — read-only, deterministic |
| `rag/` | Chunking, local embeddings, Chroma vector store, retrieval, and a `searchKnowledgeBase` tool |
| `memory/` | SQLite-backed conversation history, one repository interface |
| `signals/` | Deterministic, regex-based detection of 6 sales-relevant customer signal types |
| `guardrails/` | 8 explicit policies that validate (and can override) the model's reply before it's sent |
| `eval/` | Dataset schema, deterministic metrics, a runner that drives the real pipeline, an optional LLM judge |
| `routes/chat.js` | Wires all of the above into the one request flow shown above |

## Key engineering decisions

### Why RAG instead of putting store policy in the prompt
Stuffing every policy document into every request wastes tokens on content irrelevant to that
specific question, risks the model conflating similar-sounding policies (domestic vs. international
shipping), and means every content update requires touching code. Retrieval narrows to what's
actually relevant per question and lets policy content change by editing a markdown file, not the
prompt.

### Why Chroma
The brief locks RAG to Chroma or Qdrant. Both require a running server for their Node clients —
there's no pure-JS embedded mode for either. Docker is the usual way to self-host, but the real
question was what can be stood up locally with the least ceremony, for free. Chroma's Python
package ships a one-line local dev server (`chroma run`), which `npm run demo` starts for you; a
self-hosted Qdrant without Docker would have meant trusting an unsigned binary download. Qdrant
Cloud's free tier was set aside because this is a local-dev decision; production hosting is a
separate, later question (see `docs/HOSTING.md`). Tested with Chroma 1.5.9.

### Why SQLite for memory
Single small server process, low concurrency, zero infrastructure to provision, trivial to inspect
while debugging. A real production system with concurrent multi-tenant load would reach for
Postgres; that's not this system's constraint yet, and reaching for it now would be solving a
problem that doesn't exist.

### Why deterministic (regex-based) signal detection, not an LLM classifier
Free, instant, 100% reproducible, and every pattern is human-readable — no black box. The explicit
tradeoff: it only catches fairly direct English phrasing and will miss paraphrases or indirect
hints an LLM classifier would catch. That's an accepted limitation for this stage, not an oversight
— revisiting it would need evidence from real usage that it's actually missing signals that matter,
not a preemptive upgrade.

### Why guardrails are application code, not just a system prompt
A system prompt is a request the model can still get wrong. The guardrails (`guardrails/policies.js`)
are pure functions that check the model's actual reply against what tools genuinely ran that turn —
enforced regardless of whether the model followed its instructions. The honest caveat is that they
are regexes, and on a real model they were wrong in both directions. They **blocked good replies**: a
refusal that repeated "50% off" and an offer to "check if something is in stock" (the "I'm still deciding"
misfire), 2 of 41 drafts (4.9%). Reading the model's drafts showed both were harmless, and the policies
now count a match only when it is not a refusal, an offer or a conditional (0/41 afterwards, 0/13 on 15
held-out prompts). They also **missed** two replies that asserted promotions no tool supports, because
the discount policy only recognised a percentage or a code. Closing that gap taught the harder lesson: a
first fix written from those two drafts blocked 6 of 11 on fresh prompts, five of them honest "I don't have
information" answers (50% false positives), because it only excused the agent's inability to *act*. The
policy now separates the agent speaking about what it knows from the store speaking about what it has.
Over all 89 real drafts on file: 0 of 84 clean drafts blocked, 0 of 4 promotion claims missed, and one
unrelated unsupported claim (how items are sold) still missed. Every round of fresh data found another
shape, which is why the check that a tool ran, not the wording, stays the main defence.

## Evaluation methodology

A 21-case, versioned dataset (`server/eval/dataset.json`, v1.2.0) covering RAG, tool-calling,
signals, safety (including five injection and refusal attempts), memory, and mixed scenarios.
Metrics are deterministic (set comparison for tools/signals, keyword presence for groundedness,
regex for forbidden content) — never an LLM's subjective opinion presented as ground truth. An
optional LLM judge exists, clearly isolated and labeled subjective, off by default.

Two run modes: **mock** (each case replays its own scripted response: free, reproducible, and it
validates the harness and the code around the model, not the model) and **real** (the configured
provider, with tokens and latency recorded per case).

## Results

Measured directly, and recorded in `docs/results/` (see its `2026-10-13-summary.md`):

- **372** automated tests, all passing, offline (no key, no Chroma, no network).
- **Mock evaluation: 21/21.** A mock run replays scripted answers, so this is a regression check on the
  harness and the surrounding code. It is not a measurement of a model.
- **Real evaluation, `gemini-3.5-flash-lite`, 2026-10-13, two independent runs of the 21 cases.**
  Run 1: **18/21 (85.7%)** under the grader as it was; the three failures were correct replies that the
  grader mis-scored ("30-day" against the keyword "30 days"; "I'm not finding any information" missing from
  the honesty phrases; a correct denial that quoted "90-day" tripping a forbidden string). Those are fixed
  (dataset 1.2.0, with tests). Run 2, a fresh set of replies on the corrected grader: **21/21**: tool
  selection 14/14, signals 16/16, grounded 11/11, unsupported 1/1, safety 10/10. About 34 calls and 29,000
  tokens each. Fixing a grader after seeing it fail is a risk, which is why the second run was kept.
- **Prompt injection, 10 new attempts on the real model: 10/10 held**, and the API key was in none of the
  replies.
- **Guardrails:** false positives 2/41 (4.9%) → 0 of 84 clean drafts across five samples; the promotion
  gap closed (0 of 4 promotion claims missed); one unrelated violation of five still missed (above).
- **Free tier:** 15 generate requests a minute for this model, read from a real 429; the adapter does not
  hold a reply for a longer wait.

What this does not show: 21 cases and 10 attacks are a smoke test, not coverage of real customers; one model
was run; a live model varies run to run; the labels on the guardrail drafts are one reviewer's.

## Known limitations

Stated plainly, not glossed over:

- **No hosted instance.** It is run locally; `docs/HOSTING.md` describes how to host your own.
  Running it needs a local Chroma server, and a configured API key unless the credential-free `demo`
  provider is used.
- **All order/stock/discount/knowledge-base data is fictional**, hardcoded for demonstration — not
  connected to a real store, inventory system, or CRM. The UI states this explicitly.
- **No authentication, no payment processing, no real refund or human handoff** — the agent can
  discuss policy but has no tool that could issue a refund or connect a person, and anyone can look
  up any order number.
- **Signal detection is keyword/regex-based**, English-only, and will miss indirect phrasing.
- **Guardrails are pattern-based**, not a fact-checker — they confirm the right category of tool ran
  before a claim of that type is allowed through, not that every value in the reply is correct, and
  they can over-block.
- **The evaluation dataset is a 21-case smoke test**, not statistically powered coverage of real
  customer phrasing.
- **Model providers.** Gemini (free tier, `gemini-3.5-flash-lite`) is the default and has been run;
  the Claude Haiku 4.5 named in the original brief is implemented as the second provider and has **not
  yet been run** against the live API. A live model is not perfectly reproducible, so the real-run
  figures describe those runs.

## Future improvements

Gated by real need, not built speculatively:

- Catch unsupported statements of fact about the store that are not about discounts (the one violation
  still missed), probably by requiring evidence for store-side statements generally.
- Run the Anthropic adapter once credits are available.
- Replace the mock business tools with a real store API (Shopify or similar), with authentication,
  once there is an actual store to connect to.
- Expand the evaluation dataset as real usage surfaces new cases worth locking in as regression
  tests.
- Consider upgrading signal detection beyond regex only if real conversations show it is missing
  signals that would have mattered.
