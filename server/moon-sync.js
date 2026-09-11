const crypto = require('crypto');
const db = require('./db');

let flushing = false;

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

async function sendPayload(payload) {
  const body = JSON.stringify(payload);
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

}

function queueSale(order, project) {
  const payload = buildSalePayload(order, project);
  db.enqueueMoonSale({ externalId: payload.externalId, payload });
}

async function flushQueue() {
  if (flushing || !isConfigured()) return;
  flushing = true;
  try {
    for (const row of db.listPendingMoonSales()) {
      try {
        await sendPayload(JSON.parse(row.payloadJson));
        db.markMoonSaleSynced(row.externalId);
      } catch (err) {
        db.markMoonSaleRetry(row.externalId, err.message);
        console.error('[moon-sync] delivery failed:', err.message);
      }
    }
  } finally {
    flushing = false;
  }
}

function startWorker() {
  const first = setTimeout(flushQueue, 1000);
  first.unref();
  const interval = setInterval(flushQueue, 60_000);
  interval.unref();
}

module.exports = { buildSalePayload, flushQueue, isConfigured, queueSale, sendPayload, sign, startWorker };
