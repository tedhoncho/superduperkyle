const crypto = require('crypto');

function isConfigured() {
  return Boolean(process.env.TO_THE_MOON_SYNC_URL && process.env.TO_THE_MOON_SYNC_SECRET);
}

function buildSalePayload(order, project) {
  return {
    source: 'sdkmusic',
    eventType: 'sale.fulfilled',
    externalId: order.id,
    orderNumber: order.order_number || null,
    storeProjectId: project.id,
    projectTitle: project.title,
    projectType: project.type,
    quantity: 1,
    amountCents: order.amount_cents,
    currency: String(order.currency || 'usd').toLowerCase(),
    status: 'fulfilled',
    soldAt: order.fulfilled_at || order.created_at,
  };
}

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function syncSale(order, project) {
  if (!isConfigured()) return { ok: true, skipped: true };

  const body = JSON.stringify(buildSalePayload(order, project));
  const response = await fetch(process.env.TO_THE_MOON_SYNC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sdkmusic-signature': sign(body, process.env.TO_THE_MOON_SYNC_SECRET),
    },
    body,
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`To the Moon returned ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
  }

  return { ok: true, skipped: false };
}

module.exports = { buildSalePayload, isConfigured, sign, syncSale };
