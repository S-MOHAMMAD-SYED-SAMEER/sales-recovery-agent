import { ToolValidationError } from './errors.js';
import { systemClock, isoDay, addDays } from './clock.js';

export const name = 'checkDiscount';

export const description =
  'Check whether a discount code is currently valid and what it offers. ' +
  'Only call this when the customer gives a specific discount/coupon code to verify.';

export const parameters = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: 'The discount code the customer gave, e.g. "WELCOME10".',
    },
  },
  required: ['code'],
};

// Mock discount rules standing in for a real store's promotions system.
// Deterministic for a given input and clock day. A code is valid only while it
// is active AND not past its expiry date. WELCOME10 is written as an offset
// from "today" so it stays valid; SUMMER20 has a fixed date that has passed, so
// the demo has a code that exists but has lapsed; EXPIRED5 is switched off.
const MOCK_DISCOUNTS = {
  WELCOME10: { active: true, percentOff: 10, description: '10% off for first-time customers.', expiresInDays: 365 },
  SUMMER20: { active: true, percentOff: 20, description: '20% off summer collection items.', expires: '2026-09-01' },
  EXPIRED5: { active: false, percentOff: 5, description: 'Expired promotional code.', expires: '2025-01-01' },
};

// `now` is injectable for tests; the dispatcher only ever passes `args`.
export function execute(args, { now = systemClock } = {}) {
  const code = args && args.code;

  if (typeof code !== 'string' || !code.trim()) {
    throw new ToolValidationError('code is required and must be a non-empty string.');
  }

  const normalizedCode = code.trim().toUpperCase();
  const discount = MOCK_DISCOUNTS[normalizedCode];

  if (!discount) {
    return { valid: false, code: normalizedCode, message: 'This discount code does not exist.' };
  }

  const today = now();
  const expires = discount.expires ?? isoDay(addDays(today, discount.expiresInDays));
  const expired = expires < isoDay(today);

  return {
    valid: discount.active && !expired,
    code: normalizedCode,
    active: discount.active,
    percentOff: discount.percentOff,
    description: discount.description,
    expires,
    ...(expired ? { expired: true } : {}),
  };
}
