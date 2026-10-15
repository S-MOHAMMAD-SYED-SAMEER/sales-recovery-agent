import { AsyncLocalStorage } from 'node:async_hooks';

// A per-turn trace: what the server actually did while producing one reply, in the order it did it.
//
// It is RECORDED, not reconstructed. The code that does the work (the tool loop around each model
// call, the tool executor around each tool, the knowledge-base tool when it retrieves, the guardrail
// pass, the signal detector) adds a step at the moment it happens. Nothing here guesses afterwards
// from the reply text, and the page never invents a step: it draws what is in `steps`.
//
// How the steps get from deep inside the agent to the response without changing any provider's
// signature: the turn runs inside an AsyncLocalStorage context holding the trace, and the places above
// call `record()`. Outside a turn (unit tests of a single module, scripts) there is no context and
// `record()` does nothing.
//
// What is allowed in a step is decided here, by whitelist: names, ids, counts, numbers and short plain
// strings. Never an API key, the environment, a stack trace, the system prompt, or a passage's full
// text. Anything that came from the customer (tool arguments, the phrase a signal matched) is capped
// and stripped of control characters, because it is displayed.

const storage = new AsyncLocalStorage();

const MAX_VALUE_CHARS = 120;
const MAX_ARGS = 8;
const MAX_STEPS = 64;
const MAX_IDS = 12;

// ---- secrets -------------------------------------------------------------------------------------

// Environment variables whose NAME says the value is a credential. Their values are removed from any
// string that reaches a trace, even when a customer types one back, or a library puts one in an error.
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|BEARER)/i;
const MIN_SECRET_LENGTH = 6;
// Shapes of well-known credentials, caught even when the value is not in this process's environment.
const SECRET_SHAPES = [/AIza[0-9A-Za-z_-]{20,}/g, /sk-[A-Za-z0-9_-]{16,}/g, /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi];
const REDACTED = '[redacted]';

function secretValues(env = process.env) {
  const values = [];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && typeof value === 'string' && value.trim().length >= MIN_SECRET_LENGTH) {
      values.push(value.trim());
    }
  }
  // Longest first, so a value that contains another is removed whole.
  return values.sort((a, b) => b.length - a.length);
}

export function scrubSecrets(text, env = process.env) {
  let out = String(text);
  for (const secret of secretValues(env)) out = out.split(secret).join(REDACTED);
  for (const shape of SECRET_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

// A short plain string safe to display: no control characters, one line, capped, secrets removed.
export function cleanText(value, max = MAX_VALUE_CHARS) {
  if (value === null || value === undefined) return '';
  let text = scrubSecrets(typeof value === 'string' ? value : String(value));
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Tool arguments as the customer-derived plain strings they are: a few keys, each value a capped
// string. Objects and arrays are not expanded (their type is named), so an argument can never carry
// structure into the trace.
export function sanitizeArgs(args) {
  const out = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return out;
  for (const key of Object.keys(args).slice(0, MAX_ARGS)) {
    const value = args[key];
    const safeKey = cleanText(key, 40);
    if (!safeKey) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[safeKey] = cleanText(value);
    } else if (value === null || value === undefined) {
      out[safeKey] = '';
    } else {
      out[safeKey] = Array.isArray(value) ? '[list]' : '[object]';
    }
  }
  return out;
}

// ---- what a tool returned, in a few words ---------------------------------------------------------

// One short line per tool, from the fields the tool really returned. Unknown tools get ok/failed.
export function summarizeToolOutcome(name, outcome) {
  if (!outcome || outcome.ok !== true) {
    return `failed: ${cleanText(outcome?.error ?? 'no result', 100)}`;
  }
  const r = outcome.result ?? {};
  switch (name) {
    case 'getOrderStatus':
      if (r.found === false) return 'order not found';
      return cleanText(['found', r.status, r.carrier && `via ${r.carrier}`].filter(Boolean).join(' · '));
    case 'checkStock':
      if (r.found === false) return 'product not found';
      return cleanText(r.inStock ? `in stock (${r.quantity})` : 'out of stock');
    case 'checkDiscount':
      if (r.exists === false || (r.valid === false && r.percentOff === undefined)) return 'code does not exist';
      return cleanText(
        [r.valid ? 'valid' : r.expired ? 'expired' : 'not valid', r.percentOff !== undefined && `${r.percentOff}% off`]
          .filter(Boolean)
          .join(' · ')
      );
    case 'searchKnowledgeBase':
      if (r.unavailable) return 'knowledge base unavailable';
      if (r.found === false) return 'nothing relevant found';
      return `${Array.isArray(r.results) ? r.results.length : 0} passage(s)`;
    default:
      return 'ok';
  }
}

// "WELCOME10: verified by checkDiscount on turn 2 of this conversation".
export function describeVerification({ code, basis, turn }) {
  const who = code ? `${code}: ` : '';
  if (basis === 'this-turn') return `${who}verified by checkDiscount on this turn`;
  const where = Number.isInteger(turn) ? `on turn ${turn} of this conversation` : 'earlier in this conversation';
  return `${who}verified by checkDiscount ${where}`;
}

// ---- the trace itself -------------------------------------------------------------------------------

export function createTrace({ clock = () => performance.now(), model = null } = {}) {
  const startedAt = clock();
  const steps = [];
  // Provider and model id, named once for the turn. The demo provider makes no model call.
  let modelInfo = model;

  function add(step) {
    if (steps.length >= MAX_STEPS) return null;
    steps.push(step);
    return step;
  }

  return {
    setModel(info) {
      modelInfo = info;
    },

    // A signal the deterministic detector fired on this message, and the phrase it matched.
    signal({ type, confidence, evidence }) {
      add({
        type: 'signal',
        signal: cleanText(type, 40),
        confidence: typeof confidence === 'number' ? Number(confidence.toFixed(2)) : null,
        why: cleanText(evidence),
      });
    },

    // One model call: which model, how long it took, how many tokens in and out. `usage` is whatever
    // the adapter reported (nothing for the demo provider, which makes no call).
    modelCall({ latencyMs, usage }) {
      add({
        type: 'model',
        provider: modelInfo?.provider ?? null,
        model: modelInfo?.model ?? null,
        latencyMs: Math.round(typeof usage?.latencyMs === 'number' ? usage.latencyMs : latencyMs),
        tokensIn: typeof usage?.inputTokens === 'number' ? usage.inputTokens : null,
        tokensOut: typeof usage?.outputTokens === 'number' ? usage.outputTokens : null,
      });
    },

    // The turn used a scripted provider: no model was called. Said so, rather than leaving a gap.
    scriptedProvider({ provider, latencyMs }) {
      add({
        type: 'model',
        provider: cleanText(provider, 40),
        model: null,
        scripted: true,
        latencyMs: Math.round(latencyMs),
        tokensIn: null,
        tokensOut: null,
      });
    },

    // A tool is about to run. Returns a function that finishes the step once it has run, so the step
    // keeps its place in the order even when the tool records steps of its own (a retrieval).
    toolStarted(name, args) {
      const t0 = clock();
      const step = add({ type: 'tool', name: cleanText(name, 60), args: sanitizeArgs(args), ok: null, summary: '', ms: 0 });
      return (outcome) => {
        if (!step) return;
        step.ok = outcome?.ok === true;
        step.summary = summarizeToolOutcome(name, outcome);
        step.ms = Math.round(clock() - t0);
      };
    },

    // The knowledge base answered a query: the files and chunk ids it returned, never their text.
    retrieve({ query, results, unavailable = false }) {
      const list = Array.isArray(results) ? results : [];
      const sources = [...new Set(list.map((r) => cleanText(r.source, 80)).filter(Boolean))];
      add({
        type: 'retrieve',
        query: cleanText(query),
        unavailable: Boolean(unavailable),
        sources,
        chunks: list
          .slice(0, MAX_IDS)
          .map((r) => ({
            id: cleanText(r.id ?? '', 80) || null,
            source: cleanText(r.source, 80),
            heading: cleanText(r.heading ?? '', 80),
            relevance: typeof r.score === 'number' ? Number(r.score.toFixed(3)) : null,
          })),
      });
    },

    // One policy and what it decided. The whole reply is replaced when any policy blocks (there is no
    // partial rewrite in v1.0), so the outcome is "pass" or "block".
    guardrail({ policy, outcome, reason, rule, verified }) {
      // Why a claim was allowed, when the policy relied on a checkDiscount result: which code, and whether the
      // tool ran on this turn or on an earlier one (and which). Passed on from the policy's own decision.
      const basis = (Array.isArray(verified) ? verified : []).slice(0, 8).map((v) => ({
        code: v.code ? cleanText(v.code, 40) : null,
        basis: v.basis === 'earlier-turn' ? 'earlier-turn' : 'this-turn',
        turn: Number.isInteger(v.turn) ? v.turn : null,
      }));
      add({
        type: 'guardrail',
        policy: cleanText(policy, 60),
        outcome: outcome === 'block' ? 'block' : 'pass',
        ...(basis.length > 0 ? { verified: basis, note: basis.map(describeVerification).join('; ') } : {}),
        ...(outcome === 'block' ? { reason: cleanText(reason, 160), ...(rule ? { rule: cleanText(rule, 60) } : {}) } : {}),
      });
    },

    // The shape sent to the client.
    snapshot() {
      return { steps: steps.map((s) => ({ ...s })), totalMs: Math.round(clock() - startedAt) };
    },
  };
}

// Runs `fn` with `trace` as the current turn's trace. Everything `fn` awaits sees it.
export function runWithTrace(trace, fn) {
  return storage.run(trace, fn);
}

// The current turn's trace, or undefined outside a turn.
export function currentTrace() {
  return storage.getStore();
}
