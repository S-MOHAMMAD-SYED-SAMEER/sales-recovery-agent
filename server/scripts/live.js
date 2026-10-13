// The same one command as `npm run demo`, but against the real model: `npm run live`.
//
// Starts Chroma if it isn't running, ingests the knowledge base, and starts the app with
// LLM_PROVIDER=gemini, so every reply comes from the live Gemini API (the default model is
// gemini-3.5-flash-lite). It refuses to start, with a clear message, if GEMINI_API_KEY is not
// set, and prints the provider and model at startup (never the key).
//
// Each reply makes one to three model calls. The Gemini free tier allows 15 generate requests
// a minute for the default model, and the app's own rate limit is 30 chat requests a minute
// per IP, so leave a few seconds between messages.

import { startStack } from './lib/stack.js';

await startStack({ provider: 'gemini', tag: 'live' });
