# Sales-Recovery Support Agent (Project 1)

RAG + tool-calling + proactive-signal detection + SQLite memory + eval harness + guardrails,
for a fictional small international D2C store. Architecture is locked per
[project-brief_3.md](../project-brief_3.md) and [CLAUDE.md](../CLAUDE.md) — see the approved
architecture proposal for the full design and milestone sequence.

## Status: M3 — business tool calling

`/api/chat` can now decide it needs real business data — order status, stock, discount validity —
call a deterministic mock tool for it, and use the result in its answer. No RAG, proactive
signals, or guardrails yet.

## Structure

```
server/    Node + Express backend
web/       Minimal static demo chat page (not embedded in the portfolio)
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

## Local development

```
cd sales-recovery-agent/server
npm install
cp .env.example .env      # then fill in GEMINI_API_KEY (or ANTHROPIC_API_KEY + LLM_PROVIDER=anthropic)
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

Runs on Node's built-in test runner (`node --test`) against an in-memory SQLite database and
stubbed LLM/tool calls — no real API key or network access needed. 39 tests across four files:

- `test/conversationStore.test.js` — memory repository: creating/reusing a conversation, saving
  and retrieving messages in chronological order, session isolation, limit handling.
- `test/tools.test.js` — each real tool's mock data, input validation, unknown-tool handling, and
  the dispatcher's generic failure wrapping.
- `test/toolLoop.test.js` — the shared agent loop's mechanics: no-tool passthrough, single and
  multi-round tool execution, `toolsUsed` accounting, graceful handling of a failed tool outcome,
  and the max-iterations guard.
- `test/chat.route.test.js` — the route's contract: input validation, history passed to
  `generateReply`, `toolsUsed` surfaced correctly, memory isolation between sessions, memory
  staying clean across mixed tool/non-tool turns, and graceful degradation on LLM or store
  failures.

A note on what these tests do and don't prove: the "does an order question actually make Gemini
call `getOrderStatus`" question is real *model* judgment, not our code — asserting on that in an
offline unit test would be flaky and would test Gemini, not this codebase. The automated tests
instead use stubs that emulate a model having already decided to call a tool, to verify the
surrounding plumbing (contract, `toolsUsed` reporting, memory hygiene) deterministically. Whether
the real model actually chooses correctly is confirmed separately, live, against the real Gemini
adapter — see the M3 verification notes above.

## Next milestone (M4)

RAG: knowledge-base documents (shipping/returns/FAQ), chunking, embeddings, vector storage and
retrieval. Not started.
