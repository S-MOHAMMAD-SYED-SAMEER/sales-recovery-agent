import { POLICIES } from './policies.js';

// A safe, honest, non-fabricated fallback — never invents anything, and
// offers a concrete next step, matching the "when unavailable, say so and
// offer the safest useful next step" requirement. Used whenever the
// generated reply fails any guardrail policy.
export const SAFE_FALLBACK_REPLY =
  "I want to make sure I give you accurate information, and I'm not confident that answer is " +
  'correct. Let me connect you with our support team, who can help directly.';

// Runs every policy against the reply produced this turn. Returns
// { safe: true } or { safe: false, violations: [{ name, description, reason }] }
// — never throws, so a bug in one policy can't take down the whole request;
// see validateReply's own try/catch for that.
function checkPolicies(context) {
  const violations = [];

  for (const policy of POLICIES) {
    let reason;
    try {
      reason = policy.check(context);
    } catch (err) {
      // A policy itself misbehaving is treated as a violation, not a
      // silent pass — failing safe applies to the guardrail code too.
      reason = `Guardrail check "${policy.name}" threw: ${err.message}`;
    }
    if (reason) {
      violations.push({ name: policy.name, description: policy.description, reason });
    }
  }

  return violations.length === 0 ? { safe: true, violations: [] } : { safe: false, violations };
}

// context: { reply, toolsUsed }. Returns { safe, violations, finalReply }.
// finalReply is the reply text that should actually be shown to the user
// and persisted to memory — the original reply when safe, the fallback
// when not. Callers should never fall back to the original reply text
// themselves on an unsafe result; use finalReply.
export function validateReply({ reply, toolsUsed = [] }) {
  const result = checkPolicies({ reply, toolsUsed });

  if (result.safe) {
    return { safe: true, violations: [], finalReply: reply };
  }

  return { safe: false, violations: result.violations, finalReply: SAFE_FALLBACK_REPLY };
}

export { POLICIES };
