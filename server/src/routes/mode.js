import { config as defaultConfig, isConfigured as defaultIsConfigured } from '../config/env.js';

// What the page's header tag needs to know: is a real model answering, and which one.
//
// `live` is true only for a real provider (gemini or anthropic) that is configured, i.e. has its key.
// The model name is a configuration string, not a secret. The key is never read here, so it cannot be
// returned by accident; the test checks the whole JSON for it anyway. In every other case (the demo
// provider, or a real provider with no key, which cannot answer anything) `live` is false and no model
// is named, and the page keeps its "Demo" tag.
export function describeMode(config = defaultConfig, configured = defaultIsConfigured) {
  const provider = config.llmProvider;
  if (provider === 'gemini' && configured) return { provider, live: true, model: config.geminiModel };
  if (provider === 'anthropic' && configured) return { provider, live: true, model: config.anthropicModel };
  return { provider, live: false, model: null };
}
