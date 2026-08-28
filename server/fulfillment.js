// Shared fulfillment logic, called from both:
//  - the Stripe webhook (checkout.session.completed) — the source of truth,
//    fires even if the fan closes their browser right after paying.
//  - the success-page "give me my downloads now" endpoint — best-effort
//    instant UX, safe to call twice because everything here is idempotent.

const catalog = require('./catalog');
const db = require('./db');
const downloads = require('./downloads');
const { sendDownloadEmail, sendSaleNotification } = require('./email');

async function fulfillOrder(orderId) {
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
    return { ok: true, order, tokens, alreadyFulfilled: true };
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
      orderId: order.id,
    });
  } catch (err) {
    // Same reasoning as above — a notification hiccup shouldn't block a
    // fan's purchase from completing.
    console.error('[fulfillment] sale notification failed:', err.message);
  }

  db.markOrderFulfilled(orderId);

  return { ok: true, order, tokens, alreadyFulfilled: false };
}

module.exports = { fulfillOrder };
