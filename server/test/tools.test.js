import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getToolDefinitions, executeTool, createToolExecutor } from '../src/tools/index.js';

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

test('getOrderStatus returns deterministic data for a known order', async () => {
  const outcome = await executeTool('getOrderStatus', { orderId: '1001' });
  assert.deepEqual(outcome, {
    ok: true,
    result: {
      found: true,
      orderId: '1001',
      status: 'shipped',
      carrier: 'DHL',
      trackingNumber: 'DHL-778812',
      estimatedDelivery: '2026-08-15',
      items: ['Ceramic Mug'],
    },
  });
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

test('checkStock reports found:false for an unknown product without throwing', async () => {
  const outcome = await executeTool('checkStock', { product: 'Nonexistent Widget' });
  assert.deepEqual(outcome, { ok: true, result: { found: false, product: 'Nonexistent Widget', message: 'No matching product found in the catalog.' } });
});

test('checkStock rejects a missing product as an invalid-argument error', async () => {
  const outcome = await executeTool('checkStock', {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /product/);
});

test('checkDiscount returns deterministic data for a valid code', async () => {
  const outcome = await executeTool('checkDiscount', { code: 'welcome10' });
  assert.deepEqual(outcome, {
    ok: true,
    result: { valid: true, code: 'WELCOME10', active: true, percentOff: 10, description: '10% off for first-time customers.', expires: '2026-12-31' },
  });
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
