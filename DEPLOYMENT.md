# Deployment Checklist — Sales-Recovery Support Agent

Practical, step-by-step. Nothing here has been done yet — this is the plan from the deployment
feasibility audit, written down so it's ready to execute later. Steps marked **[YOU]** need your
account, payment method, or a credential — Claude Code cannot do these (account creation and
purchases aren't something an AI agent should do on your behalf).

Recommended architecture (see `README.md`'s "Portfolio Demo Deployment" section for the full
reasoning): app + frontend on one Render free Web Service, Chroma on a second Render free Web
Service, Gemini unchanged via env var. No code or architecture changes required — only deployment
configuration.

## Checklist

1. **[YOU]** Create a free Render account at render.com (GitHub sign-in is easiest, since the repo
   is already on GitHub).

2. **[YOU]** Connect Render to the `ai-business-automation` GitHub repository (Render will ask for
   repo access during service creation — grant it to this repo only, not your whole GitHub account,
   if it offers that choice).

3. Configure the Project 1 server as a Render **Web Service**:
   - Root directory: `sales-recovery-agent/server`
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`

4. Confirm the start command resolves to `node src/index.js` (already correct in
   `server/package.json` — no change needed).

5. **[YOU]** Set environment variables in Render's dashboard for this service (never in a file,
   never in Git):
   ```
   LLM_PROVIDER=gemini
   GEMINI_API_KEY=<your Google AI Studio key>
   GEMINI_MODEL=gemini-3.5-flash-lite
   CHROMA_HOST=<filled in after step 6>
   CHROMA_PORT=<filled in after step 6>
   CHROMA_COLLECTION=sales_recovery_kb
   ```
   Leave `PORT`, `SQLITE_PATH`, `KB_DIR` unset — they default correctly.

6. Create the second Render Web Service for Chroma:
   - Deploy from the official `chromadb/chroma` Docker image (no custom code, no repo needed for
     this one).
   - Note the hostname/port Render assigns it.

7. Go back to step 5's service and fill in `CHROMA_HOST`/`CHROMA_PORT` with the values from step 6,
   then redeploy service #1 so the env vars take effect.

8. Run ingestion once, from your local machine, pointed at the deployed Chroma instance:
   ```
   cd sales-recovery-agent/server
   CHROMA_HOST=<deployed host> CHROMA_PORT=<deployed port> npm run ingest
   ```
   (Or set those two vars in your local `.env` temporarily for this one command, then revert.)

9. Test `GET https://<your-render-app>.onrender.com/api/health` — should return `{"status":"ok"}`.

10. Test the actual demo end to end against the deployed URL — at minimum:
    - A shipping/RAG question ("How long does international shipping take?")
    - An order-status tool question ("What's the status of order 1001?")
    - A stock question ("Is the Ceramic Mug in stock?")
    - A signal case ("I'm still deciding if I need this")
    - Multi-turn memory (ask a follow-up referencing the previous message)
    - Confirm `toolsUsed`/`signals` badges in the UI match what actually happened

11. **[YOU]** Add the live demo URL to the portfolio's Project 1 card
    (`portfolio/src/data/projects.ts` — add an `href`; note: `Projects.tsx` doesn't currently render
    `href` even though the type allows it, so that component needs a small template change too —
    a separate, small follow-up task, not part of this deployment).

## Before every live client demo

Cold starts: Render free services sleep after 15 minutes idle and take ~1 minute to wake up — worst
case, both services are asleep at once. **Open the demo URL and send one test message a couple of
minutes before the call starts.** Don't let the first message during an actual demo be the one that
wakes everything up.

## Notes

- SQLite conversation memory is demo-session-scoped on Render's free tier (no persistent disk on
  free — that's a paid add-on). Acceptable for a demo; not durable storage.
- Gemini's free-tier quota is 15 requests/minute regardless of hosting — space out messages during
  a demo the same way you would locally.
- Nothing about this deployment changes the provider abstraction, RAG, tools, memory schema,
  signals, guardrails, or the evaluation harness — see `README.md` and `PROJECT-1.md` for what those
  actually are; deployment doesn't touch any of it.
