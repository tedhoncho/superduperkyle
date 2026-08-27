require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const Stripe = require('stripe');

const catalog = require('./catalog');
const db = require('./db');
const storage = require('./storage');
const downloads = require('./downloads');
const { fulfillOrder } = require('./fulfillment');
const adminRoutes = require('./admin-routes');

const app = express();
const PORT = process.env.PORT || 4242;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

// Railway (and most hosts) terminate HTTPS at their edge, then forward
// requests to this app over plain HTTP internally. Without this, Express
// has no way to know the original connection was secure, which breaks our
// session cookie: with NODE_ENV=production the cookie is marked "secure,"
// and express-session refuses to ever send a "secure" cookie over what it
// thinks is an insecure connection — so admin login would silently never
// stick. "trust proxy" tells Express to read the X-Forwarded-Proto header
// the proxy sets, so it correctly sees these requests as HTTPS.
app.set('trust proxy', 1);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
  })
);

// --- Stripe webhook needs the RAW body for signature verification, so it
// must be registered BEFORE express.json() touches the request body. ---
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      db.markOrderPaid(session.id);
      const result = await fulfillOrder(session.id);
      if (!result.ok) {
        console.error('[webhook] fulfillment failed for session', session.id, result.reason);
      }
    } catch (err) {
      console.error('[webhook] fulfillment threw:', err);
      // Return 500 so Stripe retries the webhook.
      return res.status(500).send('fulfillment error');
    }
  }

  res.json({ received: true });
});

app.use(express.json());

if (!process.env.SESSION_SECRET) {
  console.warn('[startup] SESSION_SECRET is not set — using an insecure default. Set it in .env before deploying.');
}
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 14, // 2 weeks — Kyle shouldn't have to re-login constantly
    },
  })
);

app.use('/api/admin', adminRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/art', express.static(path.join(__dirname, '..', 'data', 'art')));

// --- Catalog ---
app.get('/api/catalog', (req, res) => {
  res.json({ projects: catalog.listProjectsPublic() });
});

// Streams a short preview clip (not the full purchasable file).
app.get('/api/preview/:projectId/:trackId', (req, res) => {
  const track = catalog.getTrack(req.params.projectId, req.params.trackId);
  if (!track || !track.previewAudioFile) return res.status(404).end();
  const filePath = path.join(__dirname, '..', 'data', 'audio', track.previewAudioFile);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

// --- Checkout ---
// Body: { projectId, email, amountCents (only used/required for pwyw) }
app.post('/api/checkout', async (req, res) => {
  try {
    const { projectId, email, amountCents } = req.body || {};

    if (!projectId || !email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email and projectId are required.' });
    }

    const project = catalog.getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const { amountCents: finalAmountCents, minCents } = catalog.priceForProject(project, amountCents);

    if (project.pricingMode === 'pwyw' && (amountCents || 0) < minCents) {
      return res.status(400).json({
        error: `Minimum for this project is $${(minCents / 100).toFixed(2)}.`,
        minCents,
      });
    }

    const releasedCount = project.tracks.filter((t) => t.released).length;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: finalAmountCents,
            product_data: {
              name: project.title,
              description: `${releasedCount} track${releasedCount === 1 ? '' : 's'}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: { projectId: project.id },
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?canceled=1`,
    });

    // Record the order now (status=pending) so the success page can look it
    // up immediately even if the webhook hasn't landed yet.
    db.createOrder({
      id: session.id,
      projectId: project.id,
      email,
      amountCents: finalAmountCents,
      currency: 'usd',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout] error:', err);
    res.status(500).json({ error: 'Something went wrong creating your checkout session.' });
  }
});

// --- Success page support: confirm payment + return instant download links ---
app.get('/api/session/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    if (session.payment_status !== 'paid') {
      return res.json({ paid: false });
    }

    db.markOrderPaid(session.id);
    const result = await fulfillOrder(session.id);
    if (!result.ok) return res.status(500).json({ paid: true, error: result.reason });

    const project = catalog.getProject(result.order.project_id);
    res.json({
      paid: true,
      projectTitle: project.title,
      email: result.order.email,
      downloads: result.tokens.map(({ token, track }) => ({
        trackTitle: track.title,
        url: `/api/download/${token}`,
      })),
    });
  } catch (err) {
    console.error('[session] error:', err);
    res.status(500).json({ error: 'Could not look up your order.' });
  }
});

// Fans should see "Remember.mp3" in their Downloads folder, not the internal
// storage filename like "remember-a1b2c3.mp3" (that random suffix only exists
// so uploads never collide on disk — it was never meant to be user-facing).
function friendlyDownloadName(title, storageFilename) {
  const ext = path.extname(storageFilename) || '.mp3';
  const cleanTitle = (title || 'track').replace(/[\\/:*?"<>|]/g, '').trim() || 'track';
  return `${cleanTitle}${ext}`;
}

// --- Secure download delivery ---
app.get('/api/download/:token', async (req, res) => {
  const check = downloads.validateToken(req.params.token);
  if (!check.ok) {
    const messages = {
      not_found: 'This download link is not valid.',
      exhausted: 'This download link has already been used the maximum number of times.',
      expired: 'This download link has expired. Contact support if you still need your files.',
    };
    return res.status(410).send(messages[check.reason] || 'This download link is not valid.');
  }

  const project = catalog.getProject(check.row.project_id);
  const track = project && project.tracks.find((t) => t.id === check.row.track_id);
  if (!track) return res.status(404).send('Track not found.');

  const result = await storage.getDownloadForFile(track.audioFile);
  if (!result.ok) {
    console.error('[download] storage error:', result.reason);
    return res.status(500).send('Could not retrieve your file. Contact support.');
  }

  db.decrementTokenUse(req.params.token);

  if (result.type === 'redirect') {
    return res.redirect(result.url);
  }
  return res.download(result.filePath, friendlyDownloadName(track.title, track.audioFile));
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Kyle store server listening on ${BASE_URL}`);
  console.log(`Storage driver: ${storage.DRIVER}`);
});
