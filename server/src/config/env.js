import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SQLITE_PATH = path.resolve(__dirname, '../../data/memory.sqlite');
const DEFAULT_KB_DIR = path.resolve(__dirname, '../../data/kb');

// "demo" needs no entry in REQUIRED_VARS_BY_PROVIDER below — it is the one
// provider with no credential of any kind (see llm/providers/demo.js) — so
// it falls through to the `|| []` default and is always configured.
const VALID_PROVIDERS = ['gemini', 'anthropic', 'demo'];
const provider = (process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase();

const REQUIRED_VARS_BY_PROVIDER = {
  gemini: ['GEMINI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
};

const requiredVars = REQUIRED_VARS_BY_PROVIDER[provider] || [];
const missing = requiredVars.filter((key) => !process.env[key]);

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function optionalNumber(raw) {
  if (raw === undefined || String(raw).trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export const config = {
  port: process.env.PORT || 3000,
  llmProvider: provider,
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  // Model-call limits, shared by both providers (see llm/providers/). The
  // timeout applies to each attempt; retries are extra attempts on a 429, a 5xx
  // or a dropped connection. maxOutputTokens counts a thinking model's
  // reasoning tokens too, so it is not set tight. Temperature is left to each
  // adapter's own default unless LLM_TEMPERATURE is set.
  llmTimeoutMs: positiveInt(process.env.LLM_TIMEOUT_MS, 30_000),
  llmMaxRetries: nonNegativeInt(process.env.LLM_MAX_RETRIES, 2),
  llmMaxOutputTokens: positiveInt(process.env.LLM_MAX_OUTPUT_TOKENS, 1024),
  llmTemperature: optionalNumber(process.env.LLM_TEMPERATURE),
  sqlitePath: process.env.SQLITE_PATH || DEFAULT_SQLITE_PATH,
  chromaHost: process.env.CHROMA_HOST || 'localhost',
  chromaPort: Number(process.env.CHROMA_PORT) || 8000,
  // Whether to reach Chroma over HTTPS. Defaults to false so local dev
  // (`chroma run` on plain http://localhost:8000) is unaffected. Needed only
  // for a hosted Chroma reached over its public TLS endpoint — Render's free
  // tier exposes services on 443/HTTPS only, and its private network is not
  // available to a free Docker web service, so the public URL is the only
  // route in. Parsed the same way as LLM_PROVIDER above (trim + lowercase),
  // so "TRUE" and " true " both work; anything else is false.
  chromaSsl: (process.env.CHROMA_SSL || '').trim().toLowerCase() === 'true',
  chromaCollection: process.env.CHROMA_COLLECTION || 'sales_recovery_kb',
  kbDir: process.env.KB_DIR || DEFAULT_KB_DIR,
  // POST /api/chat only (see middleware/rateLimiter.js) — a small portfolio
  // demo default: generous enough for one visitor trying every suggested
  // question, small enough to bound a script hammering the endpoint.
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX) || 30,
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
};

export const isConfigured = VALID_PROVIDERS.includes(provider) && missing.length === 0;

if (!VALID_PROVIDERS.includes(provider)) {
  console.warn(
    `[config] Unknown LLM_PROVIDER "${provider}". Expected one of: ${VALID_PROVIDERS.join(', ')}. ` +
      '/api/chat will return a 500 until this is fixed.'
  );
} else if (!isConfigured) {
  console.warn(
    `[config] LLM_PROVIDER is "${provider}" but missing required env var(s): ${missing.join(', ')}. ` +
      'Copy server/.env.example to server/.env and fill them in — /api/chat will return a 500 until then.'
  );
}
