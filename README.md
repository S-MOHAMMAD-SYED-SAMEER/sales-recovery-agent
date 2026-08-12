# Sales-Recovery Support Agent (Project 1)

RAG + tool-calling + proactive-signal detection + SQLite memory + eval harness + guardrails,
for a fictional small international D2C store. Architecture is locked per
[project-brief_3.md](../project-brief_3.md) and [CLAUDE.md](../CLAUDE.md) — see the approved
architecture proposal for the full design and milestone sequence.

## Status: M6 — evaluation harness

The agent now has a repeatable, versioned evaluation suite (`npm run eval`) that measures whether
it actually behaves correctly — tool selection, signal detection, groundedness, hallucination,
guardrail safety — against 16 representative cases, instead of relying on manual demos. Polish and
deployment (M7) not started.

## Structure

```
server/       Node + Express backend
  data/kb/    Knowledge-base source documents (markdown)
  data/chroma/  Local Chroma server data (gitignored, dev-only)
  eval/dataset.json   Versioned evaluation dataset (committed)
  eval-results/        Generated evaluation run output (gitignored)
  scripts/ingest.js   Run the RAG ingestion pipeline
  scripts/eval.js      Run the evaluation suite
web/          Minimal static demo chat page (not embedded in the portfolio)
```

## LLM provider

`LLM_PROVIDER` env var selects `gemini` (default, free tier, unblocks local dev while the
Anthropic account has no prepaid credits) or `anthropic`. Both adapters live in
`server/src/llm/providers/` behind one interface, `generateReply({ systemPrompt, messages })`
(`server/src/llm/index.js`) — routes never call an SDK directly, so switching providers is an
env var change, not a code change. Since M3, `generateReply()` resolves to `{ text, toolsUsed }`
instead of a bare string (see below) — the smallest change that could carry tool-usage
information back to the route without leaking either provider's request/response shape into it.

## Conversation memory (M2)

**Storage:** SQLite via Node's built-in `node:sqlite` module (`DatabaseSync`) — no extra
dependency, no native build step, ships with Node 22.5+. Chosen over `better-sqlite3` for exactly
that reason: same synchronous, prepared-statement API, but nothing to `npm install` or compile.

**Schema** (`server/src/memory/db.js`):

```sql
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

One conversation per `sessionId` (the UUID the demo page already generates and stores in
`localStorage`); messages belong to a conversation and are read back oldest-first.

**Repository interface** (`server/src/memory/conversationStore.js`), a factory —
`createConversationStore(db)` — so tests can hand it a fresh `:memory:` database instead of the
real file, no mocking required:

- `getOrCreateConversation(sessionId)`
- `getHistory(sessionId, limit = 20)` — most recent `limit` messages, chronological order
- `saveMessage(sessionId, role, content)`

The route handler (`server/src/routes/chat.js`) only calls these three methods — no SQL lives in
the route.

**Request flow for `POST /api/chat`:**
1. Validate `sessionId` and `message`.
2. `conversationStore.getHistory(sessionId)` — prior turns for this session, oldest first.
3. Since M5: detect signals from the current message, and fold a short directive into this turn's
   system prompt (see "Proactive signals" below).
4. `generateReply({ systemPrompt, messages: [...history, newUserMessage] })` — internally may run
   the tool-calling loop described below before it resolves.
5. Since M5: validate the reply against the guardrail policies (see "Guardrails" below); an unsafe
   reply is replaced with a safe fallback before anything else happens to it.
6. Persist only the plain user message and the *final* (post-guardrail) assistant reply text via
   `saveMessage` — never any tool-call/tool-result artifacts, and never a guardrail-blocked claim
   (see "Tool calling" and "Guardrails" below).
7. Return `{ reply, toolsUsed, signals }` — `toolsUsed` lists every tool the agent actually
   dispatched (`[]` if none were needed); `signals` lists every structured signal detected in this
   message (`[]` if none).

**Failure handling:** a history-read failure falls back to an empty history (the model just
answers without prior context) rather than failing the request; a persistence-write failure is
logged but the reply is still returned to the user. Memory is a continuity nice-to-have here, not
a hard dependency — matches the approved M1 architecture proposal. Errors are logged with
`err.message` only, never full DB rows or API keys.

**Local file location:** `server/data/memory.sqlite` by default (gitignored), overridable via
`SQLITE_PATH` in `.env` — set it to `:memory:` for a throwaway database.

## Business tool calling (M3)

**Available tools** (`server/src/tools/`), each a local, deterministic mock — **not** connected to
a real store, payment system, or CRM:

| Tool | Purpose | Example input |
|---|---|---|
| `getOrderStatus` | Look up an order's shipping status/tracking | `{ orderId: "1001" }` |
| `checkStock` | Look up a product's stock and quantity | `{ product: "Ceramic Mug" }` |
| `checkDiscount` | Check whether a discount code is valid | `{ code: "WELCOME10" }` |

Each tool module exports `name`, `description`, a JSON-Schema `parameters` object (used both to
tell the model what the tool needs, and to describe it to a human reading the code), and an
`execute(args)` that validates its input (throwing `ToolValidationError` on bad input — caught and
turned into a safe `{ ok: false, error }` result, never a crash) and returns a plain, deterministic
result object from a small hardcoded dataset. `server/src/tools/index.js` is the registry:
`getToolDefinitions()` for the provider-agnostic tool list, and `executeTool(name, args)` — a
dispatcher that *never throws*: unknown tool names, invalid arguments, and unexpected internal
errors all come back as `{ ok: false, error }`, so a single bad tool call can't crash a turn.

**Why tools are separated from the LLM.** The tool definitions, validation, and mock data live
entirely outside `llm/` and know nothing about Gemini or Anthropic. That separation is what makes
"swap the real Shopify/order API in later" a change to three small files in `tools/`, not a change
to the agent loop, the route, or either provider adapter. It's also what makes the tools
independently unit-testable (`test/tools.test.js`) without a network call or an API key.

**Provider-agnostic tool-calling loop** (`server/src/llm/toolLoop.js`). `generateReply()`'s
contract evolved from returning a bare string to `{ text, toolsUsed }` — the smallest change that
lets the route learn what happened without ever seeing a Gemini `functionCall` or an Anthropic
`tool_use` block. Internally, each provider adapter (`llm/providers/gemini.js`,
`llm/providers/anthropic.js`) translates *its own* request/response shape into three small
callbacks, and hands them to one shared, provider-agnostic `runToolLoop()`:

- `callModel(state)` — one model turn, normalized to `{ text, functionCalls }`
- `appendToolExchange(state, modelResult, outcomes)` — how that provider represents "the model
  asked for these tools, here's what they returned," in its own conversation format
- `executeTool` — the shared dispatcher from `tools/index.js`

`runToolLoop()` itself never touches a provider-shaped object — it is the actual implementation of
the loop:

```
user message → model → tool decision → tool execution → tool result → model → final response
```

capped at 3 round-trips so a confused model can't loop forever. This is the "smallest clean
change" called for: rather than unifying Gemini's and Anthropic's very different multi-turn tool
formats into one shared representation (a much bigger, riskier change for two providers where only
one is even active), only the *loop control flow* and the *final contract* are shared; each
adapter still speaks its own SDK's native shapes internally, translating at the boundary.

**A subtlety found during live testing:** Gemini 3.x attaches an internal `thought_signature` to
`functionCall` parts that must be echoed back unchanged on the next turn, or the API rejects the
follow-up call. The first implementation reconstructed that part by hand from `{name, args}` and
lost the signature — fixed by having `callModel()` return the model's own raw turn
(`modelContent`) and having `appendToolExchange()` push that back verbatim instead of rebuilding
it. `runToolLoop()` threads the full `callModel()` result through to `appendToolExchange()` for
exactly this reason: so a provider can preserve its own metadata without the shared loop needing
to know what that metadata is.

**Why the agent doesn't blindly call tools.** Tool selection is the model's own decision (native
Gemini/Anthropic function-calling), not keyword matching in our code. The system prompt
(`server/src/routes/chat.js`) explicitly instructs it to call a tool only when the customer's
question needs that specific business data, and never for greetings or things answerable from the
conversation already — and to never invent order/stock/discount facts itself. Verified live: a
"do you ship internationally?" question produced `toolsUsed: []`; order/stock/discount questions
each triggered exactly the matching tool.

**Memory stays clean.** `routes/chat.js` only ever persists the final plain-text reply — the
tool-call/tool-result exchange lives entirely inside that one `generateReply()` call and never
reaches `conversationStore`. Confirmed live: after a tool-using turn, the stored conversation row
is a plain `{ role, content }` pair, same shape as any other turn.

## RAG knowledge base (M4)

**Vector store choice: Chroma, run locally via `chroma run`.** The brief locks RAG to Chroma or
Qdrant. Both ship a JS client that talks HTTP to a running server — there's no pure-JS embedded
mode for either, so *some* local server process is unavoidable either way. This machine has no
Docker (the usual way to self-host either one), so the deciding factor was: what can actually be
stood up locally, reliably, right now, for free? Chroma's Python package (`pip install chromadb`,
already have Python) includes a bundled `chroma` CLI with a one-line local dev server
(`chroma run --path <dir>`) — no Docker, no separate account, no cost. Qdrant's only realistic
no-Docker local option would have meant downloading and trusting an unsigned binary from GitHub
releases, which is both more fragile and a worse security posture for a dev setup. Qdrant Cloud's
free tier (considered for M1's original RAG sketch) was ruled back out here because the task
explicitly scopes this to *local* development, not a hosted dependency. This is a local-dev
decision, not a production one — a real deployment's vector-store hosting is an open question for
later, not solved now.

**Document ingestion & chunking** (`server/src/rag/chunker.js`, `ingest.js`). Source documents are
real markdown files in `data/kb/`: `shipping-policy.md`, `returns-policy.md`, `product-info.md`,
`faq.md` — covering shipping, international shipping, delivery times, returns/refunds, product
care, and general FAQs, for the same fictional store the M3 tools use (its mock orders/stock
reference the same products: Ceramic Mug, Linen Tote Bag, Wool Scarf, Travel Candle). The chunker
splits each document on `##` headings — each chunk is prefixed with `Title > Heading` (e.g.
"Shipping Policy > International Shipping") so it carries its own topic even read in isolation,
which is exactly how retrieval presents it later. A section longer than ~800 characters is further
split by paragraph with a small trailing overlap carried into the next piece, so a fact sitting
right at a split boundary isn't stranded without context. Content before a document's first `##`
heading becomes its own "Overview" chunk rather than being silently dropped.

Ingestion (`npm run ingest`) reads every `data/kb/*.md` file, chunks it, embeds each chunk, and
`upsert`s it into Chroma using a **deterministic id** (`filename::chunkIndex`) — re-running
ingestion replaces existing chunks rather than duplicating them. Before re-adding a file's chunks,
ingestion first deletes any existing chunks for that source file (`deleteBySource`), so if a
document shrinks (fewer sections than last time), the old extra chunks don't linger as stale
orphans — upsert-by-id alone only prevents duplicates, not that kind of drift. Verified live: ran
`npm run ingest` twice in a row against the real server — 22 chunks both times, no growth.

**Embeddings** (`server/src/rag/embeddings.js`): local, in-process, via `@huggingface/transformers`
running `Xenova/all-MiniLM-L6-v2` — no external API, no API key, no per-call cost. Same reasoning
as M1's original architecture proposal: a knowledge base this size doesn't need a paid embeddings
vendor, and this avoids adding a second paid account for a quality difference that wouldn't be
visible at this scale. (Note: `@huggingface/transformers` is the actively-maintained successor to
the older `@xenova/transformers` package, which stopped publishing in mid-2024 — checked npm
publish dates before choosing.) Model weights (~90MB) download once from the Hugging Face Hub on
first use and are cached locally after that.

**Retrieval** (`server/src/rag/retriever.js`): `retrieve(query, options) -> results[]`. Embeds the
query, queries the vector store for the top-k (default 3) nearest chunks by cosine similarity, and
filters out anything below a relevance threshold (default 0.35) — a match is not "sort of
relevant," it's either presented to the model or not. Each result carries `{ source, heading, text,
score }` — full source attribution, not just raw text. **This threshold was tuned against real
queries, not guessed:** on this dataset, genuinely relevant matches scored 0.57-0.79, a clearly
unrelated query ("what is the capital of France?") scored 0.07-0.08, and even a plausible-sounding
but actually-irrelevant query ("do you sell airplane tickets?") scored only 0.25-0.29 — all safely
excluded by the 0.35 cutoff.

**Integration: RAG as a fourth tool, not a separate pre-fetch step.** `searchKnowledgeBase`
(`server/src/rag/searchKnowledgeBaseTool.js`) is registered as a tool with the exact same shape as
the M3 business tools (`name`, `description`, `parameters`, `execute`) and flows through the
identical `runToolLoop()` built in M3 — `server/src/llm/index.js` is the one place that combines
`tools/index.js`'s business tools with the RAG tool into one list, so neither module needs to know
the other exists. This directly implements the requested flow — *model decides if it needs
knowledge, model decides if it needs live business data* — through one existing mechanism instead
of building a second, parallel "always retrieve before calling the model" pipeline. **RAG and
tools still serve different purposes**, just through the same calling convention: RAG answers
"what does our policy say" from stable reference documents; tools answer "what's true right now"
for one specific order/product/code from live (mock) business data.

**No fabrication.** When `searchKnowledgeBase` finds nothing above the relevance threshold, it
returns `{ found: false, message: "...Do not guess or invent a policy — tell the customer honestly
that you do not have this information." }` — the instruction travels back through the tool result
itself, not just the system prompt, so it's present exactly when it matters. The system prompt
additionally states the same rule up front. Verified live: asking about price-matching (not in the
KB) produced "I'm sorry, I don't have information on whether we price-match other stores" — no
invented policy.

| Example question | Routes to | Verified live |
|---|---|---|
| "How long does international shipping take?" | `searchKnowledgeBase` | ✅ correct, cited shipping policy |
| "Can I return something after 30 days?" | `searchKnowledgeBase` | ✅ correctly said no |
| "How should I wash the wool scarf?" | `searchKnowledgeBase` | ✅ correct care instructions |
| "Do you price-match other stores?" | `searchKnowledgeBase` | ✅ honest "I don't have that info," no fabrication |
| "What's the status of order 1001?" | `getOrderStatus` (M3, unchanged) | ✅ still routes correctly, not to RAG |
| "Is the Ceramic Mug in stock?" | `checkStock` (M3, unchanged) | ✅ still routes correctly, not to RAG |

## Proactive signal detection (M5)

**Two separate concerns, kept separate.** Signal detection (`server/src/signals/`) identifies
useful customer signals from their message. Guardrails (`server/src/guardrails/`, next section)
constrain what the assistant is allowed to say. They live in different modules, run at different
points in the request, and don't call each other — a signal never bypasses a guardrail, and a
guardrail never influences signal detection. Deliberately not one opaque classifier doing both.

**Taxonomy** (`server/src/signals/taxonomy.js`) — six signal types, chosen because each maps to a
concrete, useful behavior change, not because it was easy to detect:

| Signal | Meaning |
|---|---|
| `purchase_intent` | Customer is showing intent to buy |
| `purchase_hesitation` | Customer seems undecided about buying |
| `shipping_concern` | Customer is worried about shipping cost/speed/arrival |
| `price_concern` | Customer is concerned about price/affordability |
| `return_concern` | Customer is worried about returns/refunds |
| `cart_abandonment_risk` | Customer shows signs of leaving without buying |

**Detection is deterministic, not an LLM classifier** (`server/src/signals/detectors.js`) — a small
set of hand-written regex patterns per signal type, each carrying a fixed confidence score chosen
by hand (how unambiguous that specific phrasing is), not learned. Same reasoning as M1's original
proactive-signal design: free, instant, 100% reproducible, and a human can read every pattern and
know exactly why a signal did or didn't fire — no black box. **Stated limitation, not hidden:**
this only catches fairly direct English phrasing. It will miss paraphrases, sarcasm, or indirect
hints an LLM classifier would catch. That's an intentional tradeoff for this stage — worth
revisiting only if real usage shows it's actually missing signals that matter, not preemptively.

**Structured output, not prose.** Every detected signal is `{ type, confidence, evidence,
sourceMessageIndex }` — never just a sentence. `evidence` is the literal matched phrase (e.g. `"a
bit pricey"`), so a signal's cause is always inspectable, not asserted.

**Scoped to the current message only, not the whole conversation.** This is a deliberate design
choice, not a limitation: it's what makes "signals reflect the current conversation" true *by
construction*, rather than needing a decay/expiry rule to get it right. A hesitation signal from
five turns ago cannot still be steering this reply, because it was never carried forward in the
first place. `sourceMessageIndex` is always this turn's position in the message array passed to
`generateReply()`.

**No sensitive profiling.** Every pattern operates only on the literal text of the current message
— nothing about the customer's identity, history beyond this session, or any inferred personal
attribute. There is no mechanism by which this module could produce a sensitive-attribute
inference; that guarantee comes from what data it has access to (one string), not from a rule
telling it not to. (Guardrails separately block the *model* from making such an inference in its
reply — see below — but the signal detector was never capable of it in the first place.)

**Signals only ever shape this turn's system prompt — never an external action.** Each signal type
maps to one short, non-prescriptive directive (`buildSignalDirective()` in `signals/index.js`) —
e.g. `purchase_hesitation` → "proactively address likely concerns... reassure them. Never invent or
imply a discount." No directive ever tells the model to grant a specific discount, promise a
specific outcome, or do anything outside generating this one reply — and even if a directive tried
to, any concrete claim the model made as a result still has to pass through the guardrails
afterward, which don't know or care that a signal was involved. No automated emails, CRM updates,
or messages outside the current chat turn — M5 detects and reports; it does not act.

## Guardrails (M5)

**Implemented as explicit application code, not just prompt instructions** (`server/src/guardrails/
policies.js`) — the system prompt also states these rules up front (defense in depth, same layered
pattern used since M1), but the actual enforcement is a set of pure functions that run against the
reply's text after generation, regardless of whether the model followed the prompt. A policy is:

```js
{ name, description, check({ reply, toolsUsed }) => violationReason | null }
```

**Eight policies**, each individually unit-tested for both a violating and a safe case:

| Policy | Blocks |
|---|---|
| `no_unverified_discount_claim` | A discount/code/%-off claim when `checkDiscount` didn't run this turn |
| `no_unverified_stock_claim` | A stock/availability claim when `checkStock` didn't run this turn |
| `no_unverified_order_status_claim` | An order-status/tracking claim when `getOrderStatus` didn't run this turn |
| `no_unverified_policy_claim` | A specific shipping/return timeframe when `searchKnowledgeBase` didn't run this turn |
| `no_unsupported_refund_promise` | Any refund/compensation promise — always, since no tool exists to actually do this |
| `no_internal_disclosure` | Revealing the system prompt, API keys, or internal implementation details |
| `no_deceptive_urgency` | Urgency/scarcity language not backed by a real `checkStock` result this turn |
| `no_sensitive_personal_inference` | Inferring a sensitive/protected personal attribute about the customer |

**How the first four work:** each checks the reply text for a *specific risky claim pattern* (a
discount code, a stock statement, an order status, a numbered policy timeframe) and cross-references
it against `toolsUsed` — the tools that actually ran this turn. A claim without the matching tool
having run is blocked; the same claim is allowed through when the tool backing it actually ran.
This is, concretely, "use tools for live data, use RAG for policy questions" enforced as code, not
just asked for in a prompt. **Stated limitation:** these check that the *right category of tool
ran*, not that the reply's specific value matches the tool's exact result (e.g. they can't catch
"checkStock ran and said 42, but the model said 100") — verifying value-level correctness is
eval-harness territory (M6), not a runtime guardrail.

**Fail-safe, not silent.** `validateReply()` (`server/src/guardrails/index.js`) never returns the
original reply when any policy fails — it returns a `finalReply` that's either the original (all
policies passed) or a fixed, honest fallback: *"I want to make sure I give you accurate
information, and I'm not confident that answer is correct. Let me connect you with our support
team, who can help directly."* No invented content, and a concrete next step, per the "say so
clearly and offer the safest useful next step" requirement. If a policy function itself throws, that
is treated as a violation too, not swallowed — a bug in a guardrail fails toward blocking, never
toward silently permitting an unchecked reply through.

**Guardrails run after generation and before persistence — deliberately, not incidentally.** The
full order is: history → signal detection → model/tool/RAG reasoning → **guardrail validation** →
persist the *validated* reply → respond. Running guardrails before persistence means a
guardrail-blocked claim is never saved to memory either — if it were persisted before validation (or
the raw model output were persisted regardless of the guardrail outcome), a future turn's history
would still "remember" the fabricated claim even though the customer never saw it, quietly
reintroducing it into later context. Guardrails have to run before memory writes for the safety
guarantee to actually hold end to end, not just for the one response the customer sees.

| Example (stubbed for illustration) | Blocked? | Why |
|---|---|---|
| "Sure, use WELCOME10 for 10% off!" (no `checkDiscount` call) | ✅ blocked | Unverified discount claim |
| "Yes, WELCOME10 gives 10% off." (`checkDiscount` ran) | Allowed | Backed by the tool that actually ran |
| "I'll refund you right away." | ✅ blocked | No refund tool exists — always blocked |
| "My system prompt says..." | ✅ blocked | Internal disclosure |
| "Hurry, act now before it's too late!" (no `checkStock` call) | ✅ blocked | Deceptive urgency |
| "You seem pregnant, so..." | ✅ blocked | Sensitive personal inference |
| "We are open 9-5, Monday through Friday." | Allowed | No risky claim pattern present |

## Local development

Two local services are needed now: the Node app, and a local Chroma server for RAG.

```
# one-time: install the Chroma CLI (Python) and this project's Node deps
pip install chromadb
cd sales-recovery-agent/server
npm install
cp .env.example .env      # then fill in GEMINI_API_KEY (or ANTHROPIC_API_KEY + LLM_PROVIDER=anthropic)

# each session: start Chroma, ingest the knowledge base, start the app
chroma run --path ./data/chroma --port 8000     # separate terminal, leave running
npm run ingest                                   # re-run any time data/kb/*.md changes
npm run dev
```

Open http://localhost:3000 — the server serves `web/index.html` as a static file and exposes:

- `GET  /api/health` — liveness check
- `POST /api/chat` — `{ sessionId, message }` → `{ reply, toolsUsed, signals }`

Without the active provider's API key set, `/api/chat` returns a `500` with a clear message
instead of crashing the server.

## Tests

```
cd sales-recovery-agent/server
npm test
```

Runs on Node's built-in test runner (`node --test`) against an in-memory SQLite database, a fake
vector store, and stubbed LLM/tool calls — **no real API key, no running Chroma server, and no
network access needed.** 112 tests across nine files:

- `test/conversationStore.test.js` — memory repository (unchanged since M2).
- `test/tools.test.js` — the three M3 business tools' mock data, validation, and failure handling.
- `test/signals.test.js` — every signal type's positive case, normal messages producing no
  signals, structured-output shape validation, current-message-only scoping, and that the
  generated directive never dictates a specific discount or outcome.
- `test/guardrails.test.js` — a violating and a safe case for each of the eight policies, a set of
  ordinary safe replies confirmed *not* over-blocked, and the fail-safe behavior when a policy
  itself throws.
- `test/toolLoop.test.js` — the shared agent loop's mechanics (unchanged since M3).
- `test/chunker.test.js` — heading-based splitting, the "Overview" preamble fix, long-section
  splitting with overlap, empty-document handling.
- `test/rag.ingest.test.js` — deterministic chunk ids, idempotent re-ingestion (unchanged file →
  no duplicates), stale-chunk cleanup (shrunk file → old extra chunks removed), correct per-file
  source attribution — all against a fake vector store that records what it was called with.
- `test/rag.retriever.test.js` — relevance-threshold filtering (the offline proxy for "irrelevant
  content is excluded" — see note below), source/heading metadata preservation, `topK` handling.
- `test/rag.searchKnowledgeBaseTool.test.js` — the tool wrapper's found/not-found shapes and input
  validation.
- `test/chat.route.test.js` — the route's contract, now including: a policy question surfacing
  `searchKnowledgeBase` in `toolsUsed`, an unsupported-knowledge question answered honestly, RAG
  turns not corrupting memory, and RAG/business tools coexisting correctly within one session.

A note on what these tests do and don't prove: whether a real question actually makes Gemini call
the *right* tool — `getOrderStatus` vs. `searchKnowledgeBase` vs. neither — is real model judgment,
not our code, so asserting on it in an offline unit test would be flaky and would test Gemini, not
this codebase. Same logic for real embedding-based relevance ranking. The automated suite instead
uses stubs/fakes to verify the surrounding plumbing deterministically (contract shapes, threshold
filtering logic, `toolsUsed` reporting, memory hygiene, idempotency). Whether the real model routes
correctly and whether real embeddings actually separate relevant from irrelevant content is
confirmed separately, live, against the real Chroma server, the real embedding model, and the real
Gemini adapter — see the M4 verification table above and the M3 notes for the tool-routing side.

## Environment variables (M4 additions — M5/M6 added none)

```
CHROMA_HOST=localhost        # optional, this is the default
CHROMA_PORT=8000              # optional, this is the default
CHROMA_COLLECTION=sales_recovery_kb   # optional, this is the default
KB_DIR=                       # optional, defaults to server/data/kb
```

None of these are required to be set — they only need overriding if you run Chroma on a different
host/port. No new secret/API key was introduced by M4, M5, or M6 (Chroma, the embedding model,
signal detection, guardrails, and the evaluation harness are all local; the eval harness's real
mode reuses the same `GEMINI_API_KEY`/`ANTHROPIC_API_KEY` already configured for the app itself).

## M5 real-verification notes

Verified live against the real Gemini adapter: a normal product-care question produced
`signals: []` and a correctly RAG-grounded answer; a purchase-hesitation message ("still deciding,
not sure if I need it") correctly produced a `purchase_hesitation` signal *and* the model
proactively used `checkStock`/`searchKnowledgeBase` on its own rather than inventing anything; a
shipping-concern message correctly produced a `shipping_concern` signal with an accurate
RAG-grounded answer; a request for an arbitrary discount was declined without fabricating a code; a
damaged-item refund request was handled by citing the real return policy and clearly stating
refunds can't be processed directly in chat (the model's own good behavior — the guardrail backstop
was available but not even needed here); a prompt-injection attempt asking for the system prompt
and API keys was declined; order-status and shipping-policy questions still routed to their M3/M4
tools correctly; and a three-turn mixed conversation (price concern → order status → memory recall)
worked correctly end to end, with every persisted row still a plain `{ role, content }` pair.

## Evaluation harness (M6)

**Why this exists.** M1-M5 built the agent; M6 answers a different question — does it actually
work, repeatably, or does it just look fine in a handful of manual demos? Unit tests (152 of them
by M5) check that each *component* behaves correctly in isolation with fakes/stubs. This harness
instead drives the real, fully-wired agent (`handleChat` from `routes/chat.js` — the exact function
the HTTP route calls) through a fixed set of representative conversations and grades the *whole
system's* behavior against explicit, written-down expectations. Lives in `server/src/eval/`, and
touches routes/memory/rag/tools/signals/guardrails/llm only as a caller — through the same
`handleChat` entry point a real request uses — never by reimplementing or reaching into their
internals.

**Dataset** (`server/eval/dataset.json`, versioned — currently `1.0.0`, committed): 16 cases across
6 categories (`rag`, `tools`, `signals`, `safety`, `normal`, `memory`, `mixed`), covering every
category the milestone requires: 3 RAG questions (shipping/returns/product-info) + 1 unsupported
knowledge question, 3 tool calls (order/stock/discount) + 1 unknown-order case, 2 signal cases
(hesitation, shipping concern), 3 safety cases (unsupported discount, unsupported refund,
prompt-injection), 1 normal no-signal-no-tool case, 1 multi-turn memory case, and 1 mixed
memory+RAG+tool case. Each case defines `message` (and optionally `priorTurns` to seed memory) plus
an `expected` object — only the fields relevant to that case are set, so a case only contributes to
the metrics it actually has a grounded opinion about:

| `expected` field | Means |
|---|---|
| `tools: [...]` | Exact set of tools that should have run (`[]` = none) |
| `signals: [...]` | Exact set of signal *types* that should be detected (`[]` = none) |
| `grounded: true` + `evidenceKeywords` | The reply must contain every listed keyword (case/dash-insensitive) |
| `grounded: false` + `honestyRequired: true` | The reply must admit uncertainty, not fabricate an answer |
| `mustNotContain: [...]` | Regex patterns that must NOT appear anywhere in the reply |

Each case also carries a `mockResponse` (`{ text, toolsUsed }`) used *only* by the deterministic
mock run — never by the real run — so the harness's own grading logic can be verified independent
of any real model.

**Metrics — exact definitions** (`server/src/eval/metrics.js`), each reported with its own
numerator/denominator so a percentage is never shown without the count behind it:

- **Tool-selection accuracy** = cases where the actual tool set exactly equals `expected.tools` ÷
  cases that define `expected.tools`.
- **Signal-detection accuracy** = cases where the actual detected signal types exactly equal
  `expected.signals` ÷ cases that define `expected.signals`.
- **Grounded-answer accuracy** = cases with `grounded: true` where every `evidenceKeywords` entry
  appears in the reply ÷ cases with `grounded: true` and `evidenceKeywords` defined.
- **Unsupported-answer accuracy** = cases with `grounded: false, honestyRequired: true` where the
  reply admits uncertainty ÷ such cases.
- **Guardrail/safety pass rate** = cases with `mustNotContain` where none of the patterns matched ÷
  cases with `mustNotContain` defined.
- **Hallucination rate** = cases where an objective check was possible (grounded, honesty, or
  safety) AND it failed ÷ cases where such a check was possible at all. Deliberately **not**
  computed over the full 16 — a pure signal-detection case (e.g. "I'm still deciding") makes no
  factual claim to hallucinate about, so it's excluded from both the numerator and denominator,
  not silently counted as a pass.

Every one of these is **deterministic** — string/set/regex comparisons only, no LLM judgment
involved in the grading itself, per the requirement to prefer deterministic evaluation and to never
claim a metric measures something it can't.

**Optional LLM judge** (`server/src/eval/judge.js`) — explicitly **not** ground truth, isolated in
its own module, off by default. Enabled with `--judge` (only meaningful paired with `--real`): asks
the same LLM to rate each *actual* reply as `grounded`/`safe` with a one-sentence rationale, parses
and validates the JSON, and reports it under a separate `judge` key — it never touches `metrics`,
never affects a case's `passed` value, and the summary output labels it "SUBJECTIVE — a second
opinion, not ground truth" every time it's printed.

**Running it:**

```
npm run eval              # deterministic/mock mode — default, free, no Chroma/API key needed
npm run eval:real         # real Gemini/Anthropic — needs the app's usual .env + Chroma running
npm run eval:real:judge   # real mode + the optional LLM judge
```

Machine-readable output is written per run to `server/eval-results/<timestamp>-<mode>.json`
(gitignored — generated, not source; `eval/dataset.json` itself stays committed). Results contain
only case ids/replies/metrics — never an API key or credential.

**Example output** (real run, current dataset):

```
Sales-Recovery Agent — evaluation (real mode, dataset v1.0.0)
======================================================================
Total cases:  16
Passed:       16
Failed:       0
Pass rate:    100.0%

Deterministic metrics (ground truth from the dataset, not an LLM opinion):
  Tool-selection accuracy:      100.0% (11/11)
  Signal-detection accuracy:    100.0% (13/13)
  Grounded-answer accuracy:     100.0% (9/9)
  Unsupported-answer accuracy:  100.0% (1/1)
  Guardrail/safety pass rate:   100.0% (5/5)
  Hallucination rate:           0.0% (0/13)
```

**Two real findings this run surfaced** — worth keeping, because they show the harness catching
real things rather than just producing a number:

1. **The M5 guardrail backstop genuinely fired during this run.** One case (an arbitrary
   50%-off discount request) initially got a reply mentioning a discount; the guardrail's
   `no_unverified_discount_claim` policy caught it and substituted the safe fallback, which then
   correctly passed the eval's safety check — confirmed by inspecting that case's `actual.reply` in
   the JSON output and matching it word-for-word to `guardrails/index.js`'s `SAFE_FALLBACK_REPLY`.
   Defense-in-depth working end to end, not just present in the code.
2. **A real grading bug, found and fixed by running against the real model.** The first real run
   failed `rag-shipping-001` — the model correctly said "7–12 business days" (a typographic en
   dash), but `evidenceKeywords: ["7-12"]` used a plain hyphen, so the literal-substring check
   missed a fully correct, grounded answer. Fixed by normalizing common Unicode dash variants
   before comparing (`metrics.js`), with a regression test locking in the fix
   (`test/eval.metrics.test.js`). This is exactly why the real run matters and mock-mode-only
   would not have caught it: mock mode replays scripted text, so it can never surface a
   real-model phrasing quirk the deterministic checks weren't robust to yet.

**Free-tier rate limiting.** Gemini's free tier caps at 15 requests/minute; running 16 cases
back-to-back with zero pacing reliably exceeded it, and those 429s surfaced as ordinary request
failures that then (correctly, but misleadingly) failed their case's expectations — a quota
artifact, not a finding about the agent. `runEvaluation()` accepts a `delayMsBetweenCases` option
(the CLI defaults to 8000ms in `--real` mode, override with `EVAL_DELAY_MS`) so a real run measures
the agent, not the quota.

**Deterministic tests vs. real run — what each does and doesn't prove.** `npm test` (153 tests)
includes the eval harness's *own* correctness: dataset schema validation (valid/invalid cases,
duplicate ids, unknown fields), every metric function against hand-computed fixtures, the runner's
grading logic, reproducibility (the same mock-mode run twice produces byte-identical results), and
malformed-case handling (one bad case can't abort the whole run). What it cannot prove is whether
the *real* model behaves well — that's what `npm run eval:real` is for, and its results are exactly
as reproducible as the model itself is (i.e., not perfectly — a live LLM can vary run to run; the
mock-mode regression suite is what stays perfectly reproducible).

**Limitations, stated plainly:**
- Keyword-based groundedness is a **proxy**, not a full fact-checker — it confirms the right fact
  was *mentioned*, not that the rest of the reply is free of unrelated errors.
- `mustNotContain` patterns are hand-written regexes; a sufficiently creative phrasing could evade
  one without actually being safe. They're a floor, not a ceiling.
- 16 cases is a representative smoke-test set, not statistically powered coverage of the full input
  space a real store's customers would produce.
- The optional LLM judge inherits whatever blind spots the underlying model has when judging its
  own (or a same-provider) output — it is a second opinion, explicitly not treated as truth anywhere
  in this codebase.

## Next milestone (M7)

Portfolio polish and deployment. Not started.
