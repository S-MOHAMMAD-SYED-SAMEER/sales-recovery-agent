import { ToolValidationError } from './errors.js';

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

// Deterministic mock order data standing in for a real store's order system
// (e.g. Shopify). Same input always produces the same output.
const MOCK_ORDERS = {
  1001: {
    status: 'shipped',
    carrier: 'DHL',
    trackingNumber: 'DHL-778812',
    estimatedDelivery: '2026-08-15',
    items: ['Ceramic Mug'],
  },
  1002: {
    status: 'processing',
    carrier: null,
    trackingNumber: null,
    estimatedDelivery: '2026-08-18',
    items: ['Linen Tote Bag'],
  },
  1003: {
    status: 'delivered',
    carrier: 'FedEx',
    trackingNumber: 'FDX-991122',
    estimatedDelivery: '2026-08-05',
    items: ['Wool Scarf', 'Travel Candle'],
  },
};

export function execute(args) {
  const orderId = args && args.orderId;

  if (typeof orderId !== 'string' || !orderId.trim()) {
    throw new ToolValidationError('orderId is required and must be a non-empty string.');
  }

  const normalizedId = orderId.trim().replace(/^ORD-/i, '');
  const order = MOCK_ORDERS[normalizedId];

  if (!order) {
    return { found: false, orderId: normalizedId, message: 'No order found with this ID.' };
  }

  return { found: true, orderId: normalizedId, ...order };
}
