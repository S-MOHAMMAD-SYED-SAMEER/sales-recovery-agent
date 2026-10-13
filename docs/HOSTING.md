# Host your own instance (optional)

**You do not need this to try the project.** Run it locally with one command (see "Run it locally"
in the [README](../README.md)). No instance of it is hosted for you, and the project has never been
run in production.

This page is for anyone who wants to put their own copy online. It describes a setup that was
configured and tried on Render's free tier: the app and its web page on one Render Web Service,
Chroma on a second one, and either a Gemini key or the credential-free `demo` provider. Nothing in
the code has to change; this is deployment configuration only.

Steps marked **[YOU]** need your own account, payment method or credential.

## Before you host it

- **Do not put a real key anywhere but your host's environment-variable settings.** Never in a
  file, never in Git, never in chat or logs.
- **There is no authentication.** Anyone who can reach the URL can chat with it, and can look up
  any of the (fictional) orders by number. That is fine for fictional demo data and not for a real
  store.
- **The rate limiter is per client IP, and behind a reverse proxy every visitor looks like the same
  IP.** The server does not set Express's `trust proxy`, deliberately (so a client cannot forge the
  address with a header). Behind Render's proxy that means all visitors share one bucket of
  `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS`. Fine for a portfolio demo; not a per-user
  limit. Each real-model reply makes one to three model calls, so the limit is also your cost cap.
- **Free tiers sleep.** Render's free services stop after 15 minutes idle and take about a minute to
  wake, and the app and Chroma can both be asleep at once. Send one test message a few minutes
  before anyone needs it.
- **Node 22.13 or newer** is required (`engines` in `server/package.json`). Set `NODE_VERSION` on
  the service if your host defaults to something older.

## Checklist

1. **[YOU]** Create a free Render account (GitHub sign-in is easiest) and connect it to this
   repository. Grant access to this repository only, if Render offers that choice.

2. Create a **Web Service** for the app:
   - Root directory: `server`
   - Runtime: Node
   - Build command: `npm ci`
   - Start command: `npm start` (this runs `node src/index.js`)

3. Create a second **Web Service** for Chroma, from this repo's `chroma/Dockerfile` (a wrapper around
   the official image, pinned to the Chroma version this project was tested with; see the file):
   - Environment: **Docker**
   - Root Directory: `chroma`
   - Dockerfile Path: `Dockerfile` (relative to the root directory; Render's UI has used both
     conventions, so use whichever the field's hint implies)
   - Port: `8000`
   - No environment variables are needed, and no persistent disk (see "Notes").
   - Note the public hostname Render gives it. That is `CHROMA_HOST`.

4. **[YOU]** Set environment variables on the **app** service (not in a file):

   ```
   LLM_PROVIDER=gemini            # or "demo" for an instance that needs no key at all
   GEMINI_API_KEY=<your Google AI Studio key>
   GEMINI_MODEL=gemini-3.5-flash-lite
   CHROMA_HOST=<the Chroma service's hostname>
   CHROMA_PORT=443
   CHROMA_SSL=true
   CHROMA_COLLECTION=sales_recovery_kb
   ```

   Leave `PORT`, `SQLITE_PATH` and `KB_DIR` unset; they default correctly. The optional model-call
   limits (`LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_TEMPERATURE`) are in
   `server/.env.example`.

   **Why 443 and `CHROMA_SSL=true`, not the container's port 8000:** on Render's free tier a service
   is reachable only on its public HTTPS endpoint, and there is no private hostname for it (the
   service's Connect menu shows only outbound IP addresses). The Chroma JS client builds its URL as
   `${ssl ? 'https' : 'http'}://${host}:${port}` and cannot infer the scheme from the hostname, so
   `CHROMA_SSL` has to be set explicitly or every request goes out as plain HTTP and fails.

5. Redeploy the app so the variables take effect.

6. Load the knowledge base once, from your machine, pointed at the hosted Chroma:

   ```
   cd server
   CHROMA_HOST=<the Chroma hostname> CHROMA_PORT=443 CHROMA_SSL=true npm run ingest
   ```

   (Inline variables win over `.env`, since dotenv never overwrites a variable that is already set.)

7. Check `GET https://<your-app-host>/api/health`. It should return `{"status":"ok"}`.

8. Try it end to end: a shipping question, "What's the status of order 1001?", "Is the Ceramic Mug
   in stock?", "I'm still deciding if I need it", and a follow-up that refers to the previous message.
   The badges under each reply should match what ran.

## Notes

- **Conversation memory is not durable on the free tier.** SQLite lives on the service's ephemeral
  filesystem, so it can reset on a redeploy or restart.
- **Chroma's data has the same caveat** (it writes to `/data` in its container). It is cheap to
  recover: `npm run ingest` rebuilds the four-document knowledge base in seconds, and the app also
  notices an empty collection the next time a question needs it and re-ingests before answering
  (`server/src/rag/demoKnowledgeBase.js`). For durable vector storage, attach a Render Disk at
  `/data` on the Chroma service (a paid feature).
- **Gemini free-tier limits apply** (requests per minute and per day). The figures for the current
  model are not verified in this repo; check your project's quota in Google AI Studio. On a 429
  the app retries up to `LLM_MAX_RETRIES` times, waiting what the server asks for or a short
  backoff, but if the server asks for more than 15 s it gives up at once and the customer gets an
  error message.
- **Tested versions.** The project was tested against Chroma server 1.5.9 (`pip install
  chromadb==1.5.9` locally, or the pinned image here) and the `chromadb` JS client 3.5.0.
