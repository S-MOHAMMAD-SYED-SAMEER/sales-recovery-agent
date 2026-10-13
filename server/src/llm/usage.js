// Token and latency accounting for model calls. Each adapter reports one
// record per model call ({ inputTokens, outputTokens, totalTokens, latencyMs,
// ... }); the tool loop sums them per reply; the eval runner sums those per run.
// Tokens, not money: a price per token is not something this code can know.

function sum(records, field) {
  const values = records.map((r) => r?.[field]).filter((v) => typeof v === 'number');
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
}

// Totals over a list of per-call records, with the records themselves kept
// under `perCall`. Null when there is nothing to report (the demo provider and
// the mock eval make no model calls).
export function summarizeUsage(records) {
  const list = (records || []).filter(Boolean);
  if (list.length === 0) return null;
  return {
    calls: list.length,
    inputTokens: sum(list, 'inputTokens'),
    outputTokens: sum(list, 'outputTokens'),
    thinkingTokens: sum(list, 'thinkingTokens'),
    totalTokens: sum(list, 'totalTokens'),
    latencyMs: sum(list, 'latencyMs'),
    perCall: list,
  };
}

// Sums already-summarized usages (one per eval case) into a run total.
export function combineUsage(usages) {
  const list = (usages || []).filter(Boolean);
  if (list.length === 0) return null;
  return {
    calls: sum(list, 'calls'),
    inputTokens: sum(list, 'inputTokens'),
    outputTokens: sum(list, 'outputTokens'),
    thinkingTokens: sum(list, 'thinkingTokens'),
    totalTokens: sum(list, 'totalTokens'),
    latencyMs: sum(list, 'latencyMs'),
  };
}

// One log line. Numbers only: never the prompt, the reply or a key.
export function formatUsage(usage) {
  if (!usage) return '';
  const part = (label, value) => (value === null || value === undefined ? null : `${label}=${value}`);
  return [
    part('calls', usage.calls),
    part('inputTokens', usage.inputTokens),
    part('outputTokens', usage.outputTokens),
    part('thinkingTokens', usage.thinkingTokens),
    part('totalTokens', usage.totalTokens),
    part('latencyMs', usage.latencyMs === null || usage.latencyMs === undefined ? null : Math.round(usage.latencyMs)),
  ]
    .filter(Boolean)
    .join(' ');
}
