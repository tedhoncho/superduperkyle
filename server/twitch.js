// "Is Kyle live right now?" — powers the LIVE banner on the leaderboard page.
//
// Twitch's Helix API needs an app access token to call server-to-server.
// This never involves a fan or even Kyle logging in — it's Ted/Kyle's own
// app credentials asking Twitch a public question ("is this channel live"),
// the same way anyone could check twitch.tv/<channel> in a browser.
//
// Required env vars:
//   TWITCH_CLIENT_ID     - from a registered app at dev.twitch.tv/console
//   TWITCH_CLIENT_SECRET - from the same app
//   TWITCH_CHANNEL_LOGIN - Kyle's Twitch username (the part after twitch.tv/)
//
// Missing any of these just means the banner never shows (see isConfigured
// below) — same "fail quiet, don't break the page" treatment as the
// countdown banner when its settings aren't filled in.

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const TWITCH_CHANNEL_LOGIN = (process.env.TWITCH_CHANNEL_LOGIN || '').trim().toLowerCase();

if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !TWITCH_CHANNEL_LOGIN) {
  console.warn(
    '[startup] TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET / TWITCH_CHANNEL_LOGIN are not fully set — the "Live on Twitch" banner will stay hidden until they are.'
  );
}

// Two layers of caching keep this cheap and resilient:
//  - the app access token is reused until shortly before it expires (Twitch
//    tokens last ~60 days, so in practice this is "fetch once and forget")
//  - the live-status lookup itself is cached for STATUS_TTL_MS so a burst of
//    site traffic doesn't turn into a burst of Twitch API calls — the rate
//    limit is shared across this whole app, not per-visitor.
const STATUS_TTL_MS = 30 * 1000;
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000; // refresh a bit before Twitch would actually expire it

let cachedToken = null; // { accessToken, expiresAt }
let cachedStatus = null; // { checkedAt, data }
let inFlightRequest = null; // de-dupes concurrent lookups that land while one is already in flight

function isConfigured() {
  return !!(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET && TWITCH_CHANNEL_LOGIN);
}

async function getAppAccessToken() {
  if (cachedToken && cachedToken.expiresAt - TOKEN_SAFETY_MARGIN_MS > Date.now()) {
    return cachedToken.accessToken;
  }

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Twitch token request failed: ${res.status}`);
  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

async function fetchLiveStatus() {
  const token = await getAppAccessToken();
  const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(TWITCH_CHANNEL_LOGIN)}`, {
    headers: {
      'Client-Id': TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401) {
    // The token Twitch gave us got invalidated early (e.g. the app was reset
    // in the dev console) — drop it so the next call fetches a fresh one
    // instead of failing forever on a token we think is still good.
    cachedToken = null;
    throw new Error('Twitch API returned 401 — token was rejected.');
  }
  if (!res.ok) throw new Error(`Twitch streams request failed: ${res.status}`);
  const data = await res.json();
  const stream = data.data && data.data[0];
  return stream
    ? { live: true, title: stream.title || '', viewerCount: stream.viewer_count || 0, startedAt: stream.started_at }
    : { live: false };
}

// Public entry point used by the /api/twitch-status route. Never throws — a
// Twitch API hiccup should mean the banner just doesn't update this cycle,
// not a broken page for fans.
async function getLiveStatus() {
  if (!isConfigured()) return { live: false };

  if (cachedStatus && Date.now() - cachedStatus.checkedAt < STATUS_TTL_MS) {
    return cachedStatus.data;
  }

  if (!inFlightRequest) {
    inFlightRequest = fetchLiveStatus()
      .then((data) => {
        cachedStatus = { checkedAt: Date.now(), data };
        return data;
      })
      .catch((err) => {
        console.error('[twitch] live-status check failed:', err.message);
        // Serve the last known answer through a transient Twitch/network
        // hiccup rather than flapping the banner off; with no prior answer
        // yet, default to "not live" rather than guessing.
        return cachedStatus ? cachedStatus.data : { live: false };
      })
      .finally(() => {
        inFlightRequest = null;
      });
  }
  return inFlightRequest;
}

module.exports = { getLiveStatus, isConfigured, CHANNEL_LOGIN: TWITCH_CHANNEL_LOGIN };
