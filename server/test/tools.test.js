import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getToolDefinitions, executeTool, createToolExecutor } from '../src/tools/index.js';
import * as getOrderStatus from '../src/tools/getOrderStatus.js';
import * as checkStock from '../src/tools/checkStock.js';
import * as checkDiscount from '../src/tools/checkDiscount.js';

// The mock data's dates are relative to "today", so the tests that look at
// them pin the clock instead of depending on the day they happen to run.
const clockAt = (iso) => ({ now: () => new Date(`${iso}T12:00:00Z`) });

test('getToolDefinitions exposes exactly the three business tools', () => {
  const definitions = getToolDefinitions();
  const names = definitions.map((d) => d.name).sort();
  assert.deepEqual(names, ['checkDiscount', 'checkStock', 'getOrderStatus']);
  for (const def of definitions) {
    assert.equal(typeof def.description, 'string');
    assert.ok(def.description.length > 0);
    assert.equal(def.parameters.type, 'object');
  }
});

test('getOrderStatus returns deterministic data for a known order', () => {
  assert.deepEqual(getOrderStatus.execute({ orderId: '1001' }, clockAt('2026-10-13')), {
    found: true,
    orderId: '1001',
    status: 'shipped',
    carrier: 'DHL',
    trackingNumber: 'DHL-778812',
    estimatedDelivery: '2026-10-16',
    items: ['Ceramic Mug'],
  });
});

test('getOrderStatus dates move with the clock: due soon while shipped, in the past once delivered', () => {
  assert.equal(getOrderStatus.execute({ orderId: '1001' }, clockAt('2027-03-01')).estimatedDelivery, '2027-03-04');
  assert.equal(getOrderStatus.execute({ orderId: '1002' }, clockAt('2026-10-13')).estimatedDelivery, '2026-10-19');
  const delivered = getOrderStatus.execute({ orderId: '1003' }, clockAt('2026-10-13'));
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.estimatedDelivery, '2026-10-06');
});

test('getOrderStatus through the dispatcher returns a well-formed future delivery date for a shipped order', async () => {
  const outcome = await executeTool('getOrderStatus', { orderId: '1001' });
  assert.equal(outcome.ok, true);
  assert.match(outcome.result.estimatedDelivery, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(outcome.result.estimatedDelivery > new Date().toISOString().slice(0, 10));
});

test('getOrderStatus does not "find" inherited object properties as orders', () => {
  for (const orderId of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.deepEqual(
      getOrderStatus.execute({ orderId }),
      { found: false, orderId, message: 'No order found with this ID.' },
      orderId
    );
  }
});

test('getOrderStatus accepts an "ORD-" prefixed id and normalizes it', async () => {
  const outcome = await executeTool('getOrderStatus', { orderId: 'ORD-1001' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.orderId, '1001');
});

test('getOrderStatus reports found:false for an unknown order without throwing', async () => {
  const outcome = await executeTool('getOrderStatus', { orderId: '9999' });
  assert.deepEqual(outcome, { ok: true, result: { found: false, orderId: '9999', message: 'No order found with this ID.' } });
});

test('getOrderStatus rejects a missing orderId as an invalid-argument error', async () => {
  const outcome = await executeTool('getOrderStatus', {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /orderId/);
});

test('checkStock returns deterministic data for a known product by name', async () => {
  const outcome = await executeTool('checkStock', { product: 'Ceramic Mug' });
  assert.deepEqual(outcome, {
    ok: true,
    result: { found: true, sku: 'MUG-001', name: 'Ceramic Mug', inStock: true, quantity: 42 },
  });
});

test('checkStock matches by SKU too', async () => {
  const outcome = await executeTool('checkStock', { product: 'tote-002' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.name, 'Linen Tote Bag');
  assert.equal(outcome.result.inStock, false);
});

test('checkStock matches whole words in a product name, not substrings', () => {
  for (const product of ['mug', 'MUG', '  ceramic   mug ', 'tote bag', 'wool scarf', 'candle']) {
    assert.equal(checkStock.execute({ product }).found, true, product);
  }
  for (const product of ['a', 'm', 'ug', 'erami', 'ote', 'ool sc', 'e']) {
    assert.equal(checkStock.execute({ product }).found, false, product);
  }
});

test('checkStock reports found:false for an unknown product without throwing', async () => {
  const outcome = await executeTool('checkStock', { product: 'Nonexistent Widget' });
  assert.deepEqual(outcome, { ok: true, result: { found: false, product: 'Nonexistent Widget', message: 'No matching product found in the catalog.' } });
});

test('checkStock rejects a missing product as an invalid-argument error', async () => {
  const outcome = await executeTool('checkStock', {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /product/);
});

test('checkDiscount returns deterministic data for a valid code', () => {
  assert.deepEqual(checkDiscount.execute({ code: 'welcome10' }, clockAt('2026-10-13')), {
    valid: true,
    code: 'WELCOME10',
    active: true,
    percentOff: 10,
    description: '10% off for first-time customers.',
    expires: '2027-10-13',
  });
});

test('checkDiscount honours the expiry date: valid through the day it expires, not after', () => {
  assert.equal(checkDiscount.execute({ code: 'SUMMER20' }, clockAt('2026-08-31')).valid, true);
  assert.equal(checkDiscount.execute({ code: 'SUMMER20' }, clockAt('2026-09-01')).valid, true);

  const lapsed = checkDiscount.execute({ code: 'SUMMER20' }, clockAt('2026-09-02'));
  assert.equal(lapsed.valid, false);
  assert.equal(lapsed.expired, true);
  assert.equal(lapsed.active, true);
  assert.equal(lapsed.expires, '2026-09-01');
});

test('checkDiscount: SUMMER20 is invalid today, and WELCOME10 stays valid whatever the day', () => {
  assert.equal(checkDiscount.execute({ code: 'SUMMER20' }).valid, false);
  assert.equal(checkDiscount.execute({ code: 'WELCOME10' }).valid, true);
  // WELCOME10's expiry is an offset from "today", so it never lapses.
  assert.equal(checkDiscount.execute({ code: 'WELCOME10' }, clockAt('2030-06-15')).valid, true);
});

test('checkDiscount reports an expired code as invalid', async () => {
  const outcome = await executeTool('checkDiscount', { code: 'EXPIRED5' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.valid, false);
});

test('checkDiscount reports valid:false for an unknown code without throwing', async () => {
  const outcome = await executeTool('checkDiscount', { code: 'NOPE' });
  assert.deepEqual(outcome, { ok: true, result: { valid: false, code: 'NOPE', message: 'This discount code does not exist.' } });
});

test('checkDiscount rejects a missing code as an invalid-argument error', async () => {
  const outcome = await executeTool('checkDiscount', {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /code/);
});

test('executeTool handles an unknown tool name safely, without throwing', async () => {
  const outcome = await executeTool('deleteAllOrders', { orderId: '1001' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Unknown tool/);
});

test('executeTool handles undefined/null args safely', async () => {
  const outcome = await executeTool('getOrderStatus', undefined);
  assert.equal(outcome.ok, false);
});

test('the dispatcher catches an unexpected tool failure and reports it safely', async () => {
  const brokenTool = {
    name: 'brokenTool',
    description: 'Always fails for testing.',
    parameters: { type: 'object', properties: {} },
    execute() {
      throw new Error('unexpected internal failure');
    },
  };
  const executeBrokenTool = createToolExecutor([brokenTool]);

  const outcome = await executeBrokenTool('brokenTool', {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'brokenTool failed to execute.');
});
