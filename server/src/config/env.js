import 'dotenv/config';

const REQUIRED_VARS = ['ANTHROPIC_API_KEY'];
const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

export const config = {
  port: process.env.PORT || 3000,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
};

export const isConfigured = missing.length === 0;

if (!isConfigured) {
  console.warn(
    `[config] Missing required env var(s): ${missing.join(', ')}. ` +
      'Copy server/.env.example to server/.env and fill them in — /api/chat will return a 500 until then.'
  );
}
