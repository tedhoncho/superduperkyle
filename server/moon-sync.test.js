const assert = require('node:assert/strict');
const test = require('node:test');
const { buildSalePayload, sign } = require('./moon-sync');

test('buildSalePayload excludes customer information and keeps stable identifiers', () => {
  const payload = buildSalePayload(
    {
      id: 'cs_test_123',
      order_number: 'SDK-20260911-ABCD',
      email: 'private@example.com',
      amount_cents: 1250,
      currency: 'USD',
      created_at: '2026-09-11 12:00:00',
      fulfilled_at: '2026-09-11 12:01:00',
    },
    { id: 'imissu-71aa75', title: 'iMissU', type: 'single' }
  );

  assert.equal(payload.externalId, 'cs_test_123');
  assert.equal(payload.storeProjectId, 'imissu-71aa75');
  assert.equal(payload.amountCents, 1250);
  assert.equal(payload.currency, 'usd');
  assert.equal(payload.soldAt, '2026-09-11 12:01:00');
  assert.equal('email' in payload, false);
});

test('sign creates a stable sha256 HMAC', () => {
  assert.equal(
    sign('{"sale":1}', 'secret'),
    '83a77dc977d7afba1f34d01d0a56ea67d11b70ce336d1f53c00fbecee9846140'
  );
});
