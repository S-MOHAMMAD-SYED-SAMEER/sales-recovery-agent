# Sales-Recovery Support Agent (Project 1)

RAG + tool-calling + proactive-signal detection + SQLite memory + eval harness + guardrails,
for a fictional small international D2C store. Architecture is locked per
[project-brief_3.md](../project-brief_3.md) and [CLAUDE.md](../CLAUDE.md) — see the approved
architecture proposal for the full design and milestone sequence.

## Status: M2 — SQLite conversation memory

`/api/chat` now remembers a conversation per `sessionId`: prior turns are loaded before each
Claude/Gemini call and the new turn is persisted after. No RAG, tools, signals, or guardrails yet.

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
env var change, not a code change.

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
3. `generateReply({ systemPrompt, messages: [...history, newUserMessage] })` — same provider
   abstraction as M1, now given real history instead of a single message.
4. On success, persist both the user message and the assistant reply via `saveMessage`.
5. Return `{ reply, toolsUsed: [], signals: null }`.

**Failure handling:** a history-read failure falls back to an empty history (the model just
answers without prior context) rather than failing the request; a persistence-write failure is
logged but the reply is still returned to the user. Memory is a continuity nice-to-have here, not
a hard dependency — matches the approved M1 architecture proposal. Errors are logged with
`err.message` only, never full DB rows or API keys.

**Local file location:** `server/data/memory.sqlite` by default (gitignored), overridable via
`SQLITE_PATH` in `.env` — set it to `:memory:` for a throwaway database.

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

Runs on Node's built-in test runner (`node --test`) against an in-memory SQLite database and a
stubbed LLM call — no real API key or network access needed. Covers: creating/reusing a
conversation, saving and retrieving messages in chronological order, isolation between two
sessions, `/api/chat`'s history-usage behavior end to end, and graceful degradation when the
store or the LLM call fails.

## Next milestone (M3)

Mock product/order/discount store + Claude/Gemini tool-calling. Not started.
