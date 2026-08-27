# Super Duper Kyle — Direct Store

A minimal direct-to-fan store: browse songs/projects, preview a clip, pay via Stripe
(fixed price or pay-what-you-want), get the file instantly + by email. No Shopify,
no Bandcamp cut, no third-party platform in the middle — same idea as guap.dad/music,
built from scratch so you control the data, pricing, and fan emails.

## How it's organized

```
server/          Express API: catalog, admin dashboard API, Stripe checkout, webhook, downloads, email
public/          The fan-facing storefront (plain HTML/CSS/JS, no build step)
public/admin/    Kyle's upload dashboard — password-protected, drag-and-drop
data/audio/      The actual audio files (full masters + auto-generated preview clips)
data/art/        Cover art
data/db/         SQLite database — catalog (projects/tracks) + orders + download tokens
```

## Adding songs — the admin dashboard

This is the part built for Kyle specifically: go to `/admin` on the deployed site,
log in with the password in `ADMIN_PASSWORD` (`.env`), and:

- **New Song or Album** → give it a title, say whether it's a single/EP/album, pick a
  price (a fixed price, or "let fans pay what they want" with just a minimum — the
  quick-pick amount buttons fans see are generated automatically, no extra field to
  fill in), drop a cover image, hit Save.
- **Add a song** → open the project, drag the audio file onto the drop zone (or tap it
  to pick a file — works on a phone too), type a title, hit Add Song. The server
  detects the song's length and cuts a short preview clip automatically — nothing to
  prepare ahead of time, any common audio format works (MP3, WAV, FLAC, M4A, etc.).
- Every change is live on the storefront immediately. No restart, no deploy, no waiting.
- The checkbox on each song ("Live" / unchecked = "coming soon") controls whether it's
  buyable yet — same idea as guap.dad's locked/unreleased tracks. A project with no
  live songs just doesn't show up on the storefront at all, so a project can be
  half-built without fans seeing it.
- Up/down arrows reorder songs within a project. Delete removes the song (and its
  files) permanently — same for deleting a whole project.

**This is the only supported way to edit the catalog now** — there's no more CSV file
to hand-edit. (An earlier version of this used `data/*.csv`; `server/seed-from-csv.js`
still exists as a one-time importer for that old sample data, but isn't part of the
normal workflow.)

One real operational note: the admin login uses a server-side session that's held in
memory. That means if the server process restarts (a redeploy, a crash, Railway/Render
cycling the app), Kyle gets logged out of `/admin` and has to type the password again —
the storefront itself and everything already uploaded is completely unaffected. Not
worth the added complexity of a persistent session store for a single-user login; worth
knowing so it doesn't look like a bug.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

1. **Stripe** — from the Stripe Dashboard (test mode first): `STRIPE_SECRET_KEY`,
   `STRIPE_PUBLISHABLE_KEY`. `STRIPE_WEBHOOK_SECRET` comes from step 3 below.
2. **Resend** (email) — sign up at resend.com, verify a sending domain, get an
   API key → `RESEND_API_KEY`. Set `EMAIL_FROM` to an address on that verified domain.
   *(If you leave this blank, the app still works — it just logs "would have emailed"
   instead of sending, so you can test the whole payment flow before email is wired up.)*
3. **Webhook secret (local testing)** — install the [Stripe CLI](https://stripe.com/docs/stripe-cli),
   then in a separate terminal:
   ```bash
   stripe listen --forward-to localhost:4242/api/webhook
   ```
   It prints a `whsec_...` value — put that in `STRIPE_WEBHOOK_SECRET`.
4. **Admin dashboard** — set `ADMIN_PASSWORD` to whatever password Kyle should use at
   `/admin`, and generate a `SESSION_SECRET`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

Then:
```bash
node server/seed-from-csv.js   # optional: loads sample catalog data so there's something to look at
npm start
```
Visit `http://localhost:4242` for the storefront, `http://localhost:4242/admin` for
Kyle's dashboard.

**ffmpeg is required** (for song duration detection and auto-generated previews) —
it's not an npm package, it's a system tool. It's already on this machine, but check
on whatever server you deploy to: `which ffmpeg && which ffprobe`. Railway/Render's
default Node buildpack does NOT include it — see "Going live" below.

## Testing a full purchase (test mode)

1. `npm start`, and in another terminal `stripe listen --forward-to localhost:4242/api/webhook`.
2. Open the store, click Buy on any release, enter a test email.
3. On Stripe's checkout page, use card `4242 4242 4242 4242`, any future expiry, any CVC.
4. You should land on the success page with an instant download link, and (if
   `RESEND_API_KEY` is set) an email with the same link.
5. Check the terminal running `stripe listen` — you'll see the webhook fire and
   the server log fulfillment.

There's also `node server/test-fulfillment.js` — simulates a completed order without
needing Stripe at all, useful for testing download links/email in isolation.

## Going live

1. **Get a real Stripe account connected** (you mentioned this comes later) — swap
   `STRIPE_SECRET_KEY`/`STRIPE_PUBLISHABLE_KEY` for the live versions, and add a live
   webhook endpoint in the Stripe Dashboard pointing at
   `https://<your-deployed-domain>/api/webhook` — that gives you the live
   `STRIPE_WEBHOOK_SECRET`.
2. **Deploy the app somewhere that keeps a persistent process** — Railway is the
   easier fit given the ffmpeg requirement below (the included `nixpacks.toml`
   handles it with zero extra setup — just deploy). Render works too but its
   standard Node runtime doesn't include ffmpeg, so it needs a Dockerfile instead
   of the plain buildpack — say the word if you end up on Render and I'll write one.
   Vercel/Netlify are NOT a good fit as-is since they're serverless and this app
   keeps a local SQLite file and disk-based audio files.
3. **ffmpeg has to exist on whatever server this runs on** — the admin dashboard's
   duration detection and auto-preview-clip generation both shell out to it. Railway:
   handled automatically by `nixpacks.toml`. Anywhere else: confirm `ffmpeg`/`ffprobe`
   are installed, or the upload flow will still work but preview clips just won't
   generate (a warning shows in the admin UI when that happens — it won't fail silently).
4. **Move audio files off local disk before real songs pile up.** Railway/Render's
   disk is not guaranteed to survive every redeploy, and now that uploads happen
   live through the admin UI (not committed to git), losing that disk means losing
   Kyle's actual masters. Set `STORAGE_DRIVER=s3` in `.env`, add the S3/R2/Backblaze
   credentials, and point uploads at that bucket instead of `data/audio/`. This is a
   bigger deal now than it was with the old CSV-based catalog — flagging it as a
   priority for before Kyle uploads much real content, not an eventual nice-to-have.
5. Update `BASE_URL` and `ALLOWED_ORIGINS` in `.env` to the real deployed domain.

## Embedding into Kyle's existing site

Once this is deployed and tested on its own domain (e.g. `store.superduperkyle.com`),
the simplest integration is a link or button from his main site to this store —
zero risk to his existing site, and this app can be iterated on independently.

If you'd rather it feel fully native to his site (no separate domain in the URL bar),
the storefront's HTML/CSS/JS in `public/` can be embedded as an `<iframe>` pointed at
the deployed store, or the catalog/checkout calls (`/api/catalog`, `/api/checkout`) can
be wired into his site's own page templates directly. Which of those makes sense
depends on what his site is built on (WordPress, Squarespace, custom) — tell me once
you have access and I'll wire up that specific integration.

## Things flagged for your judgment, not decided for you

- **Pricing per release** — the admin dashboard supports both models (fixed and
  pay-what-you-want) working right now; actual prices/minimums for Kyle's real
  catalog are a business call for you and him.
- **Download link limits** — currently 5 uses, 7-day expiry (`.env`:
  `DOWNLOAD_MAX_USES`, `DOWNLOAD_LINK_EXPIRY_HOURS`). Loose enough for a fan who lost
  their file, tight enough to discourage mass-sharing a link. Adjust to taste.
- **Refunds/chargebacks** — Stripe handles the payment side, but there's no
  automatic "claw back the download" logic here (the file's already downloaded by
  the time a dispute could happen anyway) — that's a manual judgment call per case,
  same as most indie digital stores.
- **Cover art isn't covered by the S3 migration** — only audio (the paid, harder-to-
  replace content) moves to S3 when `STORAGE_DRIVER=s3`. Cover images always stay on
  local disk. Reasonable given a lost cover is a quick re-upload, not a lost master —
  but say so if that's wrong and Kyle's covers need the same protection.
- **Admin sessions are in-memory** — a server restart logs Kyle out of `/admin` (the
  storefront and everything already uploaded are unaffected). Fine for how this is
  used; would need a real session store if this ever became multi-admin or high-traffic.
