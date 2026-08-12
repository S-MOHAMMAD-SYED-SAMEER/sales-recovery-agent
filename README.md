# Sales-Recovery Support Agent (Project 1)

RAG + tool-calling + proactive-signal detection + SQLite memory + eval harness + guardrails,
for a fictional small international D2C store. Architecture is locked per
[project-brief_3.md](../project-brief_3.md) and [CLAUDE.md](../CLAUDE.md) — see the approved
architecture proposal for the full design and milestone sequence.

## Status: M1 — skeleton

Express server with a single `/api/chat` route that calls Claude directly (Haiku 4.5). No RAG,
tools, memory, signals, or guardrails yet — this milestone only proves the request/response wiring
end to end: demo page → Express → Claude API → demo page.

## Structure

```
server/    Node + Express backend
web/       Minimal static demo chat page (not embedded in the portfolio)
```

## Local development

```
cd sales-recovery-agent/server
npm install
cp .env.example .env      # then fill in ANTHROPIC_API_KEY
npm run dev
```

Open http://localhost:3000 — the server serves `web/index.html` as a static file and exposes:

- `GET  /api/health` — liveness check
- `POST /api/chat` — `{ sessionId, message }` → `{ reply, toolsUsed, signals }`

Without `ANTHROPIC_API_KEY` set, `/api/chat` returns a `500` with a clear message instead of
crashing the server.

## Next milestone (M2)

SQLite-backed conversation memory, so multi-turn context persists across requests. Not started.
