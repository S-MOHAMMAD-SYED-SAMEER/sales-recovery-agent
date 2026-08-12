import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SQLITE_PATH = path.resolve(__dirname, '../../data/memory.sqlite');
const DEFAULT_KB_DIR = path.resolve(__dirname, '../../data/kb');

const VALID_PROVIDERS = ['gemini', 'anthropic'];
const provider = (process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase();

const REQUIRED_VARS_BY_PROVIDER = {
  gemini: ['GEMINI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
};

const requiredVars = REQUIRED_VARS_BY_PROVIDER[provider] || [];
const missing = requiredVars.filter((key) => !process.env[key]);

export const config = {
  port: process.env.PORT || 3000,
  llmProvider: provider,
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  sqlitePath: process.env.SQLITE_PATH || DEFAULT_SQLITE_PATH,
  chromaHost: process.env.CHROMA_HOST || 'localhost',
  chromaPort: Number(process.env.CHROMA_PORT) || 8000,
  chromaCollection: process.env.CHROMA_COLLECTION || 'sales_recovery_kb',
  kbDir: process.env.KB_DIR || DEFAULT_KB_DIR,
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
