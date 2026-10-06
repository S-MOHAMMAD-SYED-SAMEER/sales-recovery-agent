// One command to run the whole app locally: `npm run demo`.
//
// What it does, in order:
//   1. Makes sure a Chroma server is answering at CHROMA_HOST:CHROMA_PORT,
//      starting a local one (`chroma run`, from `pip install chromadb`) if
//      nothing is there yet.
//   2. Ingests the knowledge base (data/kb/*.md) into it. Idempotent.
//   3. Starts the app with LLM_PROVIDER=demo — the deterministic,
//      credential-free provider, so no API key of any kind is needed.
//
// It is a convenience wrapper over the same three steps README.md's "Local
// development" section describes; it adds no behaviour of its own to the app.
// LLM_PROVIDER is forced rather than defaulted: this script exists to run the
// no-key demo, and a stray LLM_PROVIDER in .env should not turn it into a
// script that fails asking for a key.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.LLM_PROVIDER = 'demo';
const { config } = await import('../src/config/env.js');

const chromaUrl = `${config.chromaSsl ? 'https' : 'http'}://${config.chromaHost}:${config.chromaPort}`;
const STARTUP_TIMEOUT_MS = 60_000;

async function chromaIsUp() {
  try {
    const response = await fetch(`${chromaUrl}/api/v2/heartbeat`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForChroma() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await chromaIsUp()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

// Resolves with the child's exit code; never rejects, so a missing binary is
// reported by the caller rather than thrown from here.
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: serverDir, stdio: 'inherit', ...options });
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

let chroma = null;

async function ensureChroma() {
  if (await chromaIsUp()) {
    console.log(`[demo] Chroma already running at ${chromaUrl}.`);
    return true;
  }

  if (config.chromaHost !== 'localhost' && config.chromaHost !== '127.0.0.1') {
    console.warn(`[demo] No Chroma answering at ${chromaUrl}, and that is not a local address, so not starting one.`);
    return false;
  }

  console.log(`[demo] Starting a local Chroma server on port ${config.chromaPort}...`);
  // No shell: pip installs `chroma` as a real executable on every platform, and
  // spawning it directly means the pid below is the process we later stop.
  let chromaOutput = '';
  chroma = spawn('chroma', ['run', '--path', path.join(serverDir, 'data', 'chroma'), '--port', String(config.chromaPort)], {
    cwd: serverDir,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  chroma.stderr.on('data', (chunk) => {
    chromaOutput = (chromaOutput + chunk).slice(-1_000);
  });
  chroma.on('error', (error) => {
    chromaOutput = error.message;
  });

  if (await waitForChroma()) return true;

  console.warn(
    '[demo] Could not start Chroma. Install it once with `pip install chromadb`, then re-run `npm run demo`.' +
      (chromaOutput ? `\n[demo] Chroma said: ${chromaOutput.trim()}` : '') +
      '\n[demo] Continuing without it: order, stock and discount questions still work, but policy questions will not be answered.',
  );
  return false;
}

function stopChroma() {
  if (!chroma || chroma.killed) return;
  if (process.platform === 'win32' && chroma.pid) {
    // pip's Windows launcher starts the real server as a child process, and
    // .kill() only reaches the launcher; take the whole tree.
    spawn('taskkill', ['/pid', String(chroma.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    chroma.kill();
  }
}

process.on('SIGINT', () => {
  stopChroma();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopChroma();
  process.exit(0);
});

if (await ensureChroma()) {
  console.log('[demo] Ingesting the knowledge base (the first run downloads a ~90MB embedding model)...');
  const ingestCode = await run(process.execPath, ['scripts/ingest.js']);
  if (ingestCode !== 0) {
    console.warn('[demo] Ingestion failed — continuing; the app re-ingests on demand when a policy question needs it.');
  }
}

console.log(`[demo] Starting the app — open http://localhost:${config.port}`);
const appCode = await run(process.execPath, ['src/index.js']);
stopChroma();
process.exit(appCode);
