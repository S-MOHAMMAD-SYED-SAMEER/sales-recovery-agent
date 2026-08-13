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
   CHROMA_HOST=sales-recovery-chroma.onrender.com
   CHROMA_PORT=443
   CHROMA_SSL=true
   CHROMA_COLLECTION=sales_recovery_kb
   ```
   Leave `PORT`, `SQLITE_PATH`, `KB_DIR` unset — they default correctly.

   **Why 443 + `CHROMA_SSL=true` and not the container's port 8000:** Render's free tier exposes a
   service only on its public HTTPS endpoint (443). Port 8000 is the port Chroma binds *inside* its
   container and is not routable from outside. Render's private network — which would have allowed
   plain HTTP on `8000` between the two services — is not offered for this service: the
   `sales-recovery-chroma` Connect menu shows only Outbound IP Addresses, with no internal hostname,
   so the public TLS endpoint is the only route in. The Chroma JS client builds its URL as
   `${ssl ? 'https' : 'http'}://${host}:${port}` and cannot infer the scheme from the hostname, so
   `CHROMA_SSL` has to be set explicitly or every request goes out as plain HTTP and fails.

6. Create the second Render Web Service for Chroma, built from this repo's `sales-recovery-agent/chroma/Dockerfile`
   (a one-line wrapper around the official `chromadb/chroma` image — see that file's comments):
   - Environment: **Docker**
   - Repository: same GitHub repo as the main app
   - Root Directory: `sales-recovery-agent/chroma`
   - Dockerfile Path: `sales-recovery-agent/chroma/Dockerfile` (if Render asks for it relative to
     the repo root) or `Dockerfile` (if relative to the Root Directory you just set — Render's UI
     has used both conventions at different times; use whichever the field's own placeholder/hint
     implies)
   - Port: `8000` (matches Chroma's own default and the app's `CHROMA_PORT` default — no mismatch
     to reconcile)
   - No environment variables are required for basic operation.
   - No persistent Disk needed for a demo (see "Notes" below on what that trades away) — leave
     storage as the service's default ephemeral filesystem unless you specifically want durable
     vector storage across restarts.
   - Note the public hostname Render assigns this service — that is `CHROMA_HOST`. The port to pair
     it with is `443`, **not** 8000; see step 5's note for why.

7. Go back to step 5's service and fill in `CHROMA_HOST`/`CHROMA_PORT`/`CHROMA_SSL` with the values
   from step 6, then redeploy service #1 so the env vars take effect.

8. Run ingestion once, from your local machine, pointed at the deployed Chroma instance:
   ```
   cd sales-recovery-agent/server
   CHROMA_HOST=sales-recovery-chroma.onrender.com CHROMA_PORT=443 CHROMA_SSL=true npm run ingest
   ```
   (Or set those three vars in your local `.env` temporarily for this one command, then revert.
   Inline vars win over `.env`, since dotenv never overwrites an already-set variable.)

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
- Chroma's data lives at `/data` inside its container (that's the upstream image's own default —
  nothing in this repo's Dockerfile changes it). Same story as SQLite: on Render's free tier
  without a paid persistent Disk, that's the container's ephemeral filesystem, so the ingested
  knowledge base can be lost on a redeploy/restart. Re-running `npm run ingest` (step 8) restores
  it in seconds since the KB source files are tiny and committed to the repo — this is not lossy
  in any way that matters for a demo. If durable Chroma storage across restarts is ever wanted,
  attach a Render Disk mounted at `/data` on the Chroma service (paid feature).
- Gemini's free-tier quota is 15 requests/minute regardless of hosting — space out messages during
  a demo the same way you would locally.
- Nothing about this deployment changes the provider abstraction, RAG, tools, memory schema,
  signals, guardrails, or the evaluation harness — see `README.md` and `PROJECT-1.md` for what those
  actually are; deployment doesn't touch any of it.
