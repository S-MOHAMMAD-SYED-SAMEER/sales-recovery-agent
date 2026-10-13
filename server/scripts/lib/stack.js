// The whole local stack in one command, shared by `npm run demo` and `npm run live`.
//
// What it does, in order:
//   1. Checks the provider can run at all (a real provider needs its key) and says which
//      provider and model it is about to use. The key itself is never printed.
//   2. Makes sure a Chroma server is answering at CHROMA_HOST:CHROMA_PORT, starting a local
//      one (`chroma run`, from `pip install chromadb==1.5.9`) if nothing is there yet.
//   3. Ingests the knowledge base (data/kb/*.md) into it. Idempotent.
//   4. Starts the app with LLM_PROVIDER set to the one asked for.
//
// It adds no behaviour of its own to the app. LLM_PROVIDER is forced rather than
// defaulted: a stray LLM_PROVIDER in .env must not turn the no-key demo into a script that
// asks for a key, nor `npm run live` into one that quietly runs the stand-in.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STARTUP_TIMEOUT_MS = 60_000;

// The line printed at startup. Provider and model only; whether the key is set, never its value.
export function describeProvider(config) {
  if (config.llmProvider === 'demo') {
    return '[demo] Provider: demo (a deterministic stand-in, no model, no key).';
  }
  const model = config.llmProvider === 'gemini' ? config.geminiModel : config.anthropicModel;
  const key = config.llmProvider === 'gemini' ? config.geminiApiKey : config.anthropicApiKey;
  return `[live] Provider: ${config.llmProvider}, model: ${model} (API key ${key ? 'is set' : 'is NOT set'}).`;
}

// What stops a real provider from starting: its key. Null when it can run.
export function missingKeyMessage(config) {
  if (config.llmProvider === 'gemini' && !config.geminiApiKey) {
    return 'GEMINI_API_KEY is not set. `npm run live` talks to the real Gemini API, so it needs a key: add GEMINI_API_KEY to server/.env (see server/.env.example), or set it in your shell. Use `npm run demo` for the no-key version.';
  }
  if (config.llmProvider === 'anthropic' && !config.anthropicApiKey) {
    return 'ANTHROPIC_API_KEY is not set (see server/.env.example).';
  }
  return null;
}

export async function startStack({ provider, tag }) {
  process.env.LLM_PROVIDER = provider;
  const { config } = await import('../../src/config/env.js');

  console.log(describeProvider(config));
  const problem = missingKeyMessage(config);
  if (problem) {
    console.error(`[${tag}] Not starting: ${problem}`);
    process.exit(1);
  }

  const chromaUrl = `${config.chromaSsl ? 'https' : 'http'}://${config.chromaHost}:${config.chromaPort}`;

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
      console.log(`[${tag}] Chroma already running at ${chromaUrl}.`);
      return true;
    }

    if (config.chromaHost !== 'localhost' && config.chromaHost !== '127.0.0.1') {
      console.warn(`[${tag}] No Chroma answering at ${chromaUrl}, and that is not a local address, so not starting one.`);
      return false;
    }

    console.log(`[${tag}] Starting a local Chroma server on port ${config.chromaPort}...`);
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
      `[${tag}] Could not start Chroma. Install it once with \`pip install chromadb==1.5.9\`, then re-run.` +
        (chromaOutput ? `\n[${tag}] Chroma said: ${chromaOutput.trim()}` : '') +
        `\n[${tag}] Continuing without it: order, stock and discount questions still work, but policy questions will not be answered.`
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
    console.log(`[${tag}] Ingesting the knowledge base (the first run downloads a ~90MB embedding model)...`);
    const ingestCode = await run(process.execPath, ['scripts/ingest.js']);
    if (ingestCode !== 0) {
      console.warn(`[${tag}] Ingestion failed — continuing; the app re-ingests on demand when a policy question needs it.`);
    }
  }

  console.log(`[${tag}] Starting the app — open http://localhost:${config.port}`);
  const appCode = await run(process.execPath, ['src/index.js']);
  stopChroma();
  process.exit(appCode);
}
