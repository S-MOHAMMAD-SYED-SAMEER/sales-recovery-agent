import { ToolValidationError } from './errors.js';

export const name = 'checkStock';

export const description =
  'Check current stock availability and quantity for a product by name or SKU. ' +
  'Only call this when the customer asks whether a specific product is in stock or available.';

export const parameters = {
  type: 'object',
  properties: {
    product: {
      type: 'string',
      description: 'Product name or SKU, e.g. "Ceramic Mug" or "MUG-001".',
    },
  },
  required: ['product'],
};

// Deterministic mock product catalog standing in for a real store's
// inventory system. Same input always produces the same output.
const MOCK_PRODUCTS = [
  { sku: 'MUG-001', name: 'Ceramic Mug', inStock: true, quantity: 42 },
  { sku: 'TOTE-002', name: 'Linen Tote Bag', inStock: false, quantity: 0 },
  { sku: 'SCARF-003', name: 'Wool Scarf', inStock: true, quantity: 5 },
  { sku: 'CANDLE-004', name: 'Travel Candle', inStock: true, quantity: 120 },
];

export function execute(args) {
  const product = args && args.product;

  if (typeof product !== 'string' || !product.trim()) {
    throw new ToolValidationError('product is required and must be a non-empty string.');
  }

  const needle = product.trim().toLowerCase();
  const match = MOCK_PRODUCTS.find(
    (p) => p.sku.toLowerCase() === needle || p.name.toLowerCase().includes(needle)
  );

  if (!match) {
    return { found: false, product, message: 'No matching product found in the catalog.' };
  }

  return { found: true, sku: match.sku, name: match.name, inStock: match.inStock, quantity: match.quantity };
}
