// Splits a fulfilled order's payment across any contributors configured on
// that song, and pays each one out via a Stripe Transfer to their own
// Connect Express account -- a short flat delay after the sale (not a
// calendar-day batch) since these are digital-only sales with no shipping
// or dispute window worth waiting out. A song with zero contributors never
// creates anything here -- the full amount just stays in the store's main
// Stripe account exactly like it always has.
//
// The split math itself lives in payout-math.js, kept free of any db/Stripe
// require so it can be unit-tested with zero setup (see payout-math.test.js).

const Stripe = require('stripe');
const db = require('./db');
const { computeSplitAmounts } = require('./payout-math');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

// Flat days after a sale before its contributor payouts are eligible to go
// out -- not a calendar-day batch. Digital-only sales have no shipping or
// fulfillment disputes to wait out, so this only needs to be long enough to
// catch a same-day change-of-mind refund.
const PAYOUT_DELAY_DAYS = parseFloat(process.env.PAYOUT_DELAY_DAYS || '2');

function eligibleAtFromNow() {
  return new Date(Date.now() + PAYOUT_DELAY_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// Called once per fulfilled order (see fulfillment.js). Idempotent the same
// way the rest of fulfillOrder is -- if this order already has payout rows
// (e.g. a retried webhook), it does nothing rather than double-owing
// contributors.
function createPayoutsForOrder(order, project) {
  const splits = (project && project.contributors) || [];
  if (!splits.length) return;

  const existing = db.listPayoutsForOrder(order.id);
  if (existing.length) return;

  const amounts = computeSplitAmounts(order.amount_cents, splits);
  const eligibleAt = eligibleAtFromNow();

  for (const { contributorId, percent, amountCents } of amounts) {
    if (amountCents <= 0) continue; // a 0% row shouldn't exist, but never owe nothing
    db.insertPayout({ orderId: order.id, projectId: project.id, contributorId, percent, amountCents, eligibleAt });
  }
}

async function processDuePayout(payout) {
  const contributor = db.getContributorRow(payout.contributor_id);
  if (!contributor || !contributor.stripe_account_id) {
    db.markPayoutFailed(payout.id, 'Contributor has no connected Stripe account.');
    return;
  }

  const order = db.getOrder(payout.order_id);
  try {
    const transfer = await stripe.transfers.create({
      amount: payout.amount_cents,
      currency: (order && order.currency) || 'usd',
      destination: contributor.stripe_account_id,
      transfer_group: payout.order_id,
      description: `${payout.project_id} — ${contributor.name}`,
    });
    db.markPayoutPaid(payout.id, transfer.id);
  } catch (err) {
    db.markPayoutFailed(payout.id, err.message);
    console.error('[payouts] transfer failed for payout', payout.id, err.message);
  }
}

let sweeping = false;

// Runs on a timer (see startPayoutTimer) rather than on admin page loads --
// this moves real money, so it shouldn't depend on someone happening to have
// the admin dashboard open the moment a payout comes due.
async function runPayoutSweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const payout of db.listDuePayouts()) {
      await processDuePayout(payout);
    }
  } finally {
    sweeping = false;
  }
}

function startPayoutTimer() {
  // Catches anything that came due while the process was down (a deploy, a
  // restart) shortly after boot, then keeps checking every 30 minutes --
  // frequent enough that a 2-day delay stays accurate to within half an hour.
  const first = setTimeout(() => runPayoutSweep().catch((err) => console.error('[payouts] sweep failed:', err.message)), 5000);
  first.unref();
  const interval = setInterval(
    () => runPayoutSweep().catch((err) => console.error('[payouts] sweep failed:', err.message)),
    30 * 60 * 1000
  );
  interval.unref();
}

module.exports = {
  PAYOUT_DELAY_DAYS,
  computeSplitAmounts,
  createPayoutsForOrder,
  runPayoutSweep,
  startPayoutTimer,
};
