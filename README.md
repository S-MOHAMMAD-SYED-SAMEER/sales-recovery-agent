# Sales-Recovery Support Agent (Project 1)

RAG + tool-calling + proactive-signal detection + SQLite memory + eval harness + guardrails,
for a fictional small international D2C store. Architecture is locked per
[project-brief_3.md](../project-brief_3.md) and [CLAUDE.md](../CLAUDE.md) — see the approved
architecture proposal for the full design and milestone sequence.

## Status: M4 — RAG knowledge base

`/api/chat` now has a real persistent knowledge base (shipping/returns/product/FAQ policy
documents) it can search and ground answers in, alongside M3's business tools. No proactive
signals or guardrails yet.

## Structure

```
server/       Node + Express backend
  data/kb/    Knowledge-base source documents (markdown)
  data/chroma/  Local Chroma server data (gitignored, dev-only)
  scripts/ingest.js   Run the RAG ingestion pipeline
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
3. `generateReply({ systemPrompt, messages: [...history, newUserMessage] })` — internally may run
   the tool-calling loop described below before it resolves.
4. On success, persist only the plain user message and assistant reply text via `saveMessage` —
   never any tool-call/tool-result artifacts (see "Tool calling" below).
5. Return `{ reply, toolsUsed, signals: null }`, where `toolsUsed` lists every tool the agent
   actually dispatched while producing that reply (`[]` if none were needed).

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
network access needed.** 63 tests across seven files:

- `test/conversationStore.test.js` — memory repository (unchanged since M2).
- `test/tools.test.js` — the three M3 business tools' mock data, validation, and failure handling.
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

## Environment variables (M4 additions)

```
CHROMA_HOST=localhost        # optional, this is the default
CHROMA_PORT=8000              # optional, this is the default
CHROMA_COLLECTION=sales_recovery_kb   # optional, this is the default
KB_DIR=                       # optional, defaults to server/data/kb
```

None of these are required to be set — they only need overriding if you run Chroma on a different
host/port. No new secret/API key was introduced by M4 (Chroma and the embedding model are both
local, no account needed).

## Next milestone (M5)

Proactive-signal detection and guardrails. Not started.
