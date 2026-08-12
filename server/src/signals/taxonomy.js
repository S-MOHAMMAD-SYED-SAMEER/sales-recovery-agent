// A small, explicit signal taxonomy for an e-commerce/D2C sales-recovery
// assistant. Deliberately short — each entry earns its place by mapping to
// a concrete, useful behavior change (see signals/index.js's directives).
// Not a general sentiment/intent classifier: no speculative categories.
export const SIGNAL_TYPES = {
  purchase_intent: 'The customer is showing intent to buy (e.g. asking how to check out or order).',
  purchase_hesitation: 'The customer seems undecided about buying (e.g. "still deciding", "not sure I need this").',
  shipping_concern: 'The customer is worried about shipping — cost, speed, or whether an order has arrived.',
  price_concern: 'The customer is concerned about price or affordability.',
  return_concern: 'The customer is worried about returns/refunds before or after a purchase.',
  cart_abandonment_risk: 'The customer shows signs of leaving without completing a purchase.',
};

export const SIGNAL_TYPE_NAMES = Object.keys(SIGNAL_TYPES);
