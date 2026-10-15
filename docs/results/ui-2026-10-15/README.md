# UI screenshots, 2026-10-15

Screenshots of the chat page after the agent UI upgrade (PR #31), taken in headless Chrome against `npm run live`
(the page header shows the real `Live · gemini-3.5-flash-lite` tag from `/api/mode`).

| File | What it shows |
|---|---|
| `desktop-light.png` | 1440 px, light theme, Customer view: the five video prompts, answers with tool, source-file and signal chips |
| `desktop-dark-operator.png` | 1440 px, dark theme, Operator view: the steps of the "I like it, but I'm still deciding" reply (signal, model call with tokens, knowledge-base search, the files and chunk ids it returned, the second model call, the eight guardrail policies) |
| `mobile-375.png` | 375 px, light theme, Customer view (no horizontal scroll) |
| `mobile-375-operator-sheet.png` | 375 px, the Operator panel as a bottom sheet |

**What is real in them.** The replies and traces are the ones the server returned in the single real rehearsal run
of the same day (`../2026-10-15-ui-rehearsal-gemini-3.5-flash-lite.json`: 5 prompts, 8 model requests). The page is the
real page; `POST /api/chat` is answered from that file by the screenshot script (`screenshots.mjs`) so the screenshots
cost no further model requests. Nothing in a trace was edited.

`headless-check.mjs` is the browser check described in [docs/TESTING.md](../../TESTING.md). It is not part of
`npm test` (the suite has no browser) and needs `playwright-core` and a system Chrome.
