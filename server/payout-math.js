// Pure split-amount math, deliberately kept free of any require('./db') or
// require('stripe') -- this is the one piece of the payouts feature that
// actually moves money math around, so it's worth being able to run its
// tests (payout-math.test.js) on any machine, with no database or Stripe
// key needed at all.

// Splits amountCents across a song's configured contributors. Kyle is never
// a row here and never computed here -- every song starts at an implicit
// 100%, each contributor's percent is carved out of that, and whatever
// isn't listed in `splits` simply never gets an amount computed for it, so
// it stays in the main account untouched.
function computeSplitAmounts(amountCents, splits) {
  return (splits || []).map(({ contributorId, percent }) => ({
    contributorId,
    percent,
    amountCents: Math.round((amountCents * percent) / 100),
  }));
}

module.exports = { computeSplitAmounts };
