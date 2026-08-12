import { ToolValidationError } from './errors.js';

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

// Deterministic mock discount rules standing in for a real store's
// promotions system. Same input always produces the same output.
const MOCK_DISCOUNTS = {
  WELCOME10: { active: true, percentOff: 10, description: '10% off for first-time customers.', expires: '2026-12-31' },
  SUMMER20: { active: true, percentOff: 20, description: '20% off summer collection items.', expires: '2026-09-01' },
  EXPIRED5: { active: false, percentOff: 5, description: 'Expired promotional code.', expires: '2025-01-01' },
};

export function execute(args) {
  const code = args && args.code;

  if (typeof code !== 'string' || !code.trim()) {
    throw new ToolValidationError('code is required and must be a non-empty string.');
  }

  const normalizedCode = code.trim().toUpperCase();
  const discount = MOCK_DISCOUNTS[normalizedCode];

  if (!discount) {
    return { valid: false, code: normalizedCode, message: 'This discount code does not exist.' };
  }

  return { valid: discount.active, code: normalizedCode, ...discount };
}
