// Shared failure handling for the model adapters: which errors are worth a
// retry, how long to wait, and the error type for a response that arrived but
// has nothing usable in it. Pure functions with injectable sleep/random, so the
// behaviour is tested without a network or a real clock.

// A model reply that came back but cannot be used: blocked by a safety filter,
// refused, empty, or cut off before any text. `retryable` says whether asking
// again could plausibly give a different answer (a flaky empty turn) or would
// just repeat the same refusal (a safety block).
export class LlmResponseError extends Error {
  constructor(message, { retryable = false, finishReason } = {}) {
    super(message);
    this.name = 'LlmResponseError';
    this.retryable = retryable;
    this.finishReason = finishReason;
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function isRetryable(err) {
  if (!err) return false;
  if (err instanceof LlmResponseError) return err.retryable;
  if (RETRYABLE_STATUS.has(err.status)) return true;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  if (RETRYABLE_CODES.has(err.code) || RETRYABLE_CODES.has(err.cause?.code)) return true;
  // undici reports a dropped connection as "TypeError: fetch failed".
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  return headers[name] ?? headers[name.toLowerCase()];
}

// How long the server asked us to wait, in ms, or undefined if it didn't say.
// Looks at the Retry-After headers (seconds or an HTTP date) when the SDK
// exposes them, and at the "retryDelay": "28s" detail Gemini puts in a 429
// body, which the Gemini SDK surfaces only inside the error message.
export function requestedDelayMs(err, now = Date.now) {
  const ms = Number(readHeader(err?.headers, 'retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0) return ms;

  const retryAfter = readHeader(err?.headers, 'retry-after');
  if (retryAfter !== undefined && retryAfter !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now());
  }

  const fromBody = /retry(?:Delay)?"?\s*(?::|in)\s*"?(\d+(?:\.\d+)?)\s*s/i.exec(String(err?.message ?? ''));
  if (fromBody) return Number(fromBody[1]) * 1000;

  return undefined;
}

// Runs `operation` and retries it on a retryable failure, at most `maxRetries`
// more times. The wait is whatever the server asked for; otherwise exponential
// backoff with a little jitter. If the server asks for longer than
// `maxDelayMs` the request is not retried at all: a customer waiting on a chat
// reply is better told "try again shortly" now than held for a minute, and a
// per-day quota will not clear by waiting anyway.
export async function withRetry(
  operation,
  {
    maxRetries = 2,
    baseDelayMs = 500,
    maxDelayMs = 15_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    now = Date.now,
    onRetry = () => {},
  } = {}
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err)) throw err;

      const requested = requestedDelayMs(err, now);
      if (requested !== undefined && requested > maxDelayMs) throw err;

      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt + random() * baseDelayMs);
      const delayMs = requested !== undefined ? requested : backoff;
      onRetry({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
