// A minimal, in-process, sliding-window rate limiter for POST /api/chat —
// small on purpose: no Redis, no external service, no new dependency. This
// project runs as one process, so an in-memory map is the whole store.
//
// Keyed by the request's own socket peer address (`req.ip`), never by
// X-Forwarded-For or any other client-supplied header. Express's `req.ip`
// already ignores those unless `app.set('trust proxy', ...)` is configured —
// see server/src/index.js, which deliberately does not set it — so this is
// safe by relying on an existing default rather than adding a new check.
//
// A pluggable clock (default Date.now) is the whole testing story: tests
// build their own createRateLimiter({ clock }) instance and move time by
// calling the fake clock directly, rather than this module reaching for
// real wall-clock time or any shared/global limiter state. Nothing here is
// a singleton, so no test can leak rate-limit state into another.

export const DEFAULT_LIMIT = 30;
export const DEFAULT_WINDOW_MS = 60_000;

function defaultKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// limit: max requests per key inside windowMs. windowMs: the sliding window
// size. clock: () => number, milliseconds — defaults to Date.now.
export function createRateLimiter({
  limit = DEFAULT_LIMIT,
  windowMs = DEFAULT_WINDOW_MS,
  clock = Date.now,
  keyFn = defaultKey,
} = {}) {
  // key -> ascending array of admission timestamps still inside the window.
  const hits = new Map();

  function prune(timestamps, cutoff) {
    let firstKept = 0;
    while (firstKept < timestamps.length && timestamps[firstKept] < cutoff) {
      firstKept += 1;
    }
    return firstKept === 0 ? timestamps : timestamps.slice(firstKept);
  }

  return function rateLimiter(req, res, next) {
    const now = clock();
    const cutoff = now - windowMs;
    const key = keyFn(req);

    const timestamps = prune(hits.get(key) || [], cutoff);

    if (timestamps.length >= limit) {
      hits.set(key, timestamps);
      const retryAfterSeconds = Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: 'Too many requests. Please try again in a moment.' });
      return;
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    next();
  };
}
