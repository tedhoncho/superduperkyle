// Shared fulfillment logic, called from both:
//  - the Stripe webhook (checkout.session.completed) — the source of truth,
//    fires even if the fan closes their browser right after paying.
//  - the success-page "give me my downloads now" endpoint — best-effort
//    instant UX, safe to call twice because everything here is idempotent.

const catalog = require('./catalog');
const db = require('./db');
const downloads = require('./downloads');
const { sendDownloadEmail, sendSaleNotification } = require('./email');
const moonSync = require('./moon-sync');

async function syncSaleWithoutBlockingCustomer(order, project) {
  try {
    await moonSync.syncSale(order, project);
    return false;
  } catch (err) {
    console.error('[fulfillment] To the Moon sync failed:', err.message);
    return true;
  }
}

async function fulfillOrder(orderId, { syncToMoon = false } = {}) {
  const order = db.getOrder(orderId);
  if (!order) return { ok: false, reason: 'order_not_found' };

  // Idempotent: if we already issued tokens for this order, just return them.
  const existing = db.getTokensForOrder(orderId);
  if (existing.length > 0) {
    const project = catalog.getProject(order.project_id);
    const tokens = existing.map((row) => ({
      token: row.token,
      track: project.tracks.find((t) => t.id === row.track_id),
    }));
    const syncFailed = syncToMoon && project ? await syncSaleWithoutBlockingCustomer(order, project) : false;
    return { ok: true, order, tokens, alreadyFulfilled: true, syncFailed };
  }

  const project = catalog.getProject(order.project_id);
  if (!project) return { ok: false, reason: 'project_not_found' };

  const tokens = downloads.issueTokensForOrder({ orderId, project });

  const baseUrl = process.env.BASE_URL || 'http://localhost:4242';
  try {
    await sendDownloadEmail({
      to: order.email,
      artistName: process.env.ARTIST_NAME || 'The Artist',
      projectTitle: project.title,
      baseUrl,
      tokens,
      expiryHours: downloads.EXPIRY_HOURS,
    });
  } catch (err) {
    // Don't fail fulfillment if email sending has a hiccup — the fan can
    // still get their files from the success page, and the webhook can be
    // safely retried by Stripe (tokens already exist, so this is idempotent).
    console.error('[fulfillment] email send failed:', err.message);
  }

  try {
    await sendSaleNotification({
      artistName: process.env.ARTIST_NAME || 'The Artist',
      projectTitle: project.title,
      amountCents: order.amount_cents,
      currency: order.currency,
      customerEmail: order.email,
      orderId: order.order_number,
    });
  } catch (err) {
    // Same reasoning as above — a notification hiccup shouldn't block a
    // fan's purchase from completing.
    console.error('[fulfillment] sale notification failed:', err.message);
  }

  db.markOrderFulfilled(orderId);

  // The customer already has their download tokens before this runs. If the
  // reporting service is temporarily unavailable, the Stripe webhook is told
  // to retry while the success page can still give the customer their files.
  const fulfilledOrder = db.getOrder(orderId) || order;
  const syncFailed = syncToMoon ? await syncSaleWithoutBlockingCustomer(fulfilledOrder, project) : false;

  return { ok: true, order: fulfilledOrder, tokens, alreadyFulfilled: false, syncFailed };
}

module.exports = { fulfillOrder };
