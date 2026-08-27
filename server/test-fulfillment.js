// One-off manual test: simulates what the Stripe webhook does, without
// needing real Stripe keys. Run with: node server/test-fulfillment.js
require('dotenv').config();
const db = require('./db');
const { fulfillOrder } = require('./fulfillment');

async function main() {
  const orderId = 'test_session_' + Date.now();
  db.createOrder({
    id: orderId,
    projectId: 'sdk-goodvibes',
    email: 'fan-test@example.com',
    amountCents: 299,
    currency: 'usd',
  });

  const result = await fulfillOrder(orderId);
  console.log('Fulfillment result:', JSON.stringify(result, (k, v) => (k === 'row' ? undefined : v), 2));

  if (result.ok) {
    console.log('\nGenerated download token(s):');
    for (const t of result.tokens) {
      console.log(`  ${t.track.title} -> http://localhost:4242/api/download/${t.token}`);
    }
  }
}

main().then(() => process.exit(0));
