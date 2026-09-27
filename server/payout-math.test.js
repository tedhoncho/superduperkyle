const assert = require('node:assert/strict');
const test = require('node:test');
const { computeSplitAmounts } = require('./payout-math');

test('computeSplitAmounts carves each contributor\'s cut out of the sale total', () => {
  const amounts = computeSplitAmounts(1000, [
    { contributorId: 'a', percent: 10 },
    { contributorId: 'b', percent: 15 },
  ]);
  assert.deepEqual(amounts, [
    { contributorId: 'a', percent: 10, amountCents: 100 },
    { contributorId: 'b', percent: 15, amountCents: 150 },
  ]);
  // The remaining 75% (750 cents) is never computed as a row here at all --
  // it just isn't transferred anywhere, so it stays in the main account.
});

test('computeSplitAmounts rounds each contributor to the nearest cent independently', () => {
  const amounts = computeSplitAmounts(999, [{ contributorId: 'a', percent: 33 }]);
  assert.equal(amounts[0].amountCents, 330);
});

test('computeSplitAmounts returns an empty list for a song with no contributors', () => {
  assert.deepEqual(computeSplitAmounts(1000, []), []);
  assert.deepEqual(computeSplitAmounts(1000, undefined), []);
});

test('computeSplitAmounts never invents a Kyle row -- only the contributors passed in are ever computed', () => {
  const amounts = computeSplitAmounts(1000, [{ contributorId: 'a', percent: 20 }]);
  assert.equal(amounts.length, 1);
  assert.equal(amounts.find((a) => a.contributorId === 'kyle'), undefined);
});
