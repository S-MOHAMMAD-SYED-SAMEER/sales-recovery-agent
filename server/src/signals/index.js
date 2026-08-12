import { detectFromMessage } from './detectors.js';
import { SIGNAL_TYPES } from './taxonomy.js';

// One safe, non-prescriptive behavioral nudge per signal type. These never
// tell the model to grant a specific discount, promise a specific outcome,
// or take any action outside its normal tools — they only shape tone/focus
// for this reply. Any concrete claim (a discount, a policy detail) the
// model makes as a result still has to come from a real tool/RAG call and
// still passes through the guardrails afterward — a directive here cannot
// bypass that.
const DIRECTIVES = {
  purchase_intent:
    'The customer is showing purchase intent — keep their path to buying as frictionless as ' +
    'possible; answer directly and avoid unnecessary friction.',
  purchase_hesitation:
    'The customer seems hesitant about buying — proactively address likely concerns (shipping, ' +
    'returns, fit) using your tools/knowledge base, and reassure them. Never invent or imply a ' +
    "discount that hasn't been verified with the discount tool.",
  shipping_concern:
    'The customer has a shipping concern — proactively look up accurate shipping/delivery ' +
    'information for them using the knowledge base.',
  price_concern:
    'The customer has expressed a price concern — you may check a discount code if they mention ' +
    'one, but never invent or imply a discount exists.',
  return_concern:
    'The customer has a returns/refund concern — reassure them using the real return policy from ' +
    'the knowledge base.',
  cart_abandonment_risk:
    'The customer may be about to leave without completing a purchase — be warm and directly ' +
    'address their concern, without being pushy or using manipulative urgency.',
};

// Scoped to the single current user message, not the whole conversation
// history. This is a deliberate choice, not an oversight: it's what keeps
// "signals reflect the current conversation" true by construction — a
// hesitation signal from five turns ago should not still be steering this
// reply, and this design makes that impossible rather than relying on some
// decay/expiry rule to get it right.
export function detectSignals(message, { sourceMessageIndex } = {}) {
  return detectFromMessage(message).map((signal) => ({
    ...signal,
    ...(sourceMessageIndex === undefined ? {} : { sourceMessageIndex }),
  }));
}

// Turns detected signals into a short, additive system-prompt block. Empty
// string (not injected at all) when there's nothing to say.
export function buildSignalDirective(signals) {
  if (!signals || signals.length === 0) return '';

  const lines = [...new Set(signals.map((s) => DIRECTIVES[s.type]).filter(Boolean))];
  if (lines.length === 0) return '';

  return `\n\nDetected customer signal(s) for this message:\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

export { SIGNAL_TYPES };
