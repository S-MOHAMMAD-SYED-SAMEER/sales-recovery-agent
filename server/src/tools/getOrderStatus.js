import { ToolValidationError } from './errors.js';
import { systemClock, isoDay, addDays } from './clock.js';

export const name = 'getOrderStatus';

export const description =
  'Look up the status and tracking info of an existing order by its order ID. ' +
  'Only call this when the customer references a specific order they have already placed.';

export const parameters = {
  type: 'object',
  properties: {
    orderId: {
      type: 'string',
      description: 'The order ID the customer gave, e.g. "1001" or "ORD-1001".',
    },
  },
  required: ['orderId'],
};

// Mock order data standing in for a real store's order system (e.g.
// Shopify). Deterministic: the same input and the same clock day give the same
// output. Delivery dates are offsets from "today" (see ./clock.js) so a
// "shipped, due soon" order stays believable instead of drifting into the past.
const MOCK_ORDERS = {
  1001: {
    status: 'shipped',
    carrier: 'DHL',
    trackingNumber: 'DHL-778812',
    deliveryOffsetDays: 3,
    items: ['Ceramic Mug'],
  },
  1002: {
    status: 'processing',
    carrier: null,
    trackingNumber: null,
    deliveryOffsetDays: 6,
    items: ['Linen Tote Bag'],
  },
  1003: {
    status: 'delivered',
    carrier: 'FedEx',
    trackingNumber: 'FDX-991122',
    deliveryOffsetDays: -7,
    items: ['Wool Scarf', 'Travel Candle'],
  },
};

// `now` is injectable for tests; the dispatcher only ever passes `args`.
export function execute(args, { now = systemClock } = {}) {
  const orderId = args && args.orderId;

  if (typeof orderId !== 'string' || !orderId.trim()) {
    throw new ToolValidationError('orderId is required and must be a non-empty string.');
  }

  const normalizedId = orderId.trim().replace(/^ORD-/i, '');
  // Own keys only: a plain-object lookup would also "find" inherited names
  // such as "constructor" or "__proto__".
  const order = Object.hasOwn(MOCK_ORDERS, normalizedId) ? MOCK_ORDERS[normalizedId] : undefined;

  if (!order) {
    return { found: false, orderId: normalizedId, message: 'No order found with this ID.' };
  }

  const { deliveryOffsetDays, ...record } = order;
  return {
    found: true,
    orderId: normalizedId,
    status: record.status,
    carrier: record.carrier,
    trackingNumber: record.trackingNumber,
    estimatedDelivery: isoDay(addDays(now(), deliveryOffsetDays)),
    items: record.items,
  };
}
