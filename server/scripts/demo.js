// One command to run the whole app locally with no API key: `npm run demo`.
//
// Starts Chroma if it isn't running, ingests the knowledge base, and starts the app with
// LLM_PROVIDER=demo, the deterministic, credential-free stand-in (no model is called).
// The steps are in scripts/lib/stack.js, shared with `npm run live`.

import { startStack } from './lib/stack.js';

await startStack({ provider: 'demo', tag: 'demo' });
