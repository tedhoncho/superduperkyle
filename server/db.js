// Lightweight SQLite store for orders and download tokens.
// SQLite (file-based) is plenty for an indie-artist direct store's order volume,
// and needs zero external services to run. If this ever needs to run across
// multiple server instances at once, swap this file for a Postgres client —
// the rest of the app only calls the functions exported below.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '..', 'data', 'db', 'store.sqlite3');
// better-sqlite3 won't create a missing parent folder itself — it just
// throws. Locally and on the old ephemeral disk this folder happened to
// already exist, but a fresh Railway Volume mounts empty, so this has to be
// created explicitly (same pattern uploads.js already uses for audio/art).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'single',   -- single | ep | album
  release_year TEXT,
  cover_art_file TEXT,
  pricing_mode TEXT NOT NULL,            -- fixed | pwyw
  fixed_price_cents INTEGER,
  pwyw_min_per_track_cents INTEGER,
  suggested_amounts_cents TEXT,          -- pipe-separated, auto-derived from the minimum
  description TEXT,
  sold_out INTEGER NOT NULL DEFAULT 0,   -- 0/1 — stays visible/previewable, just can't be bought
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  track_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  audio_file TEXT NOT NULL,
  preview_audio_file TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  released INTEGER NOT NULL DEFAULT 1,   -- 0/1
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tracks_project ON tracks(project_id);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,               -- Stripe Checkout Session id (internal key, never shown to fans/Ted)
  order_number TEXT,                 -- human-friendly: SDK-YYYYMMDD-XXXX, shown in emails/reports
  project_id TEXT NOT NULL,
  email TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending', -- pending -> paid -> fulfilled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fulfilled_at TEXT
);

CREATE TABLE IF NOT EXISTS download_tokens (
  token TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  project_id TEXT NOT NULL,
  track_id TEXT NOT NULL,            -- '*' means "whole project zip" if you add zipping later
  uses_remaining INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tokens_order ON download_tokens(order_id);

-- Feature Contest leaderboard: picks Kyle makes live on his Twitch stream
-- from fan submissions, added by hand after each stream. rank_position is a
-- manual up/down order (same idea as projects.display_order) kept ready for
-- a future actual-ranking contest — today's leaderboard sorts by stream_date
-- instead (see settings.leaderboard_sort_mode), so this column just sits
-- populated and unused until that switch gets flipped.
CREATE TABLE IF NOT EXISTS leaderboard_entries (
  id TEXT PRIMARY KEY,
  artist TEXT NOT NULL,
  song_title TEXT NOT NULL,
  stream_date TEXT NOT NULL,       -- 'YYYY-MM-DD', the date this was picked on stream
  link TEXT,                       -- optional — only shown publicly when set
  is_winner INTEGER NOT NULL DEFAULT 0,  -- 0/1 — only one row should have this set; see setLeaderboardWinner
  rank_position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-row table for admin-editable settings (notification recipients,
-- the fan-facing confirmation message). Deliberately separate from secrets
-- like RESEND_API_KEY/STRIPE keys, which stay as Railway env vars — those
-- are credentials, not day-to-day content Kyle/Ted would want to edit from
-- a web form.
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sale_notification_emails TEXT NOT NULL DEFAULT '',
  confirmation_message TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO settings (id, sale_notification_emails, confirmation_message) VALUES (1, '', '');
`);

// --- Migration: storefront content fields on settings (header tagline +
// release countdown). Added after the settings table already shipped, so —
// same as the projects.display_order migration above — check via PRAGMA
// before altering rather than assuming a fresh table. ---
const settingsColumns = db.prepare(`PRAGMA table_info(settings)`).all().map((c) => c.name);
const settingsMigrations = {
  header_tagline: `ALTER TABLE settings ADD COLUMN header_tagline TEXT NOT NULL DEFAULT ''`,
  countdown_enabled: `ALTER TABLE settings ADD COLUMN countdown_enabled INTEGER NOT NULL DEFAULT 0`,
  countdown_label: `ALTER TABLE settings ADD COLUMN countdown_label TEXT NOT NULL DEFAULT ''`,
  countdown_target_at: `ALTER TABLE settings ADD COLUMN countdown_target_at TEXT`,
  // Feature Contest leaderboard tab. leaderboard_visible is the on/off switch
  // Ted flips himself once Kyle picks a winner — deliberately manual, not
  // date-driven, since raffles/review backlogs can slip the real end date.
  // leaderboard_sort_mode is 'date' (default, today's contest) or 'rank'
  // (future-proofing for an actual ranked contest — see rank_position above).
  leaderboard_visible: `ALTER TABLE settings ADD COLUMN leaderboard_visible INTEGER NOT NULL DEFAULT 0`,
  leaderboard_sort_mode: `ALTER TABLE settings ADD COLUMN leaderboard_sort_mode TEXT NOT NULL DEFAULT 'date'`,
  // Playlist Kyle adds his favorite stream submissions to. Shown as a
  // pinned footer player on the leaderboard page — deliberately independent
  // of leaderboard_visible above, since the playlist is an ongoing thing,
  // not tied to any one month's contest. Empty string = don't show it.
  spotify_playlist_id: `ALTER TABLE settings ADD COLUMN spotify_playlist_id TEXT NOT NULL DEFAULT ''`,
  // Editable heading/subheading shown at the top of the public leaderboard
  // page (above the entries). One pair of text, used regardless of sort
  // mode — rank mode is dormant, so there's no need for it to carry its own
  // separate copy right now. Defaults match the text that was hardcoded
  // before this became editable, so nothing changes on the live site until
  // Ted actually edits it.
  leaderboard_heading: `ALTER TABLE settings ADD COLUMN leaderboard_heading TEXT NOT NULL DEFAULT 'Feature Contest Leaderboard'`,
  leaderboard_subheading: `ALTER TABLE settings ADD COLUMN leaderboard_subheading TEXT NOT NULL DEFAULT 'Every stream, Kyle picks his favorite submissions — these are added to the pool for the end-of-month feature.'`,
  // Future-proofing, same spirit as leaderboard_sort_mode above: fan thumbs
  // are fully wired up but stay off (0) until Ted turns them on for a
  // contest he actually wants them live for.
  leaderboard_thumbs_enabled: `ALTER TABLE settings ADD COLUMN leaderboard_thumbs_enabled INTEGER NOT NULL DEFAULT 0`,
  // Separate from the toggle above on purpose: Ted's plan is to launch
  // thumbs with voting wide open (repeat clicks welcome, to get traffic
  // going while the site is new/low-traffic) and only turn on the
  // one-vote-per-browser limit later once there's enough traffic that
  // ballot-stuffing actually matters. Off = unlimited voting.
  leaderboard_thumbs_limit_one: `ALTER TABLE settings ADD COLUMN leaderboard_thumbs_limit_one INTEGER NOT NULL DEFAULT 0`,
  // Contest rounds: the contest-wide "what's currently live" switch. Every
  // entry carries its own round (see the leaderboard_entries migration
  // below) — this is the separate, deliberate flip that decides which round
  // the PUBLIC page treats as active. Entries at the active round are "in
  // the running"; everyone else falls back to Honorable Mentions (subject to
  // the toggle right below). Defaults to 'pool' so nothing changes for
  // existing contests until Ted actually advances one.
  leaderboard_contest_round: `ALTER TABLE settings ADD COLUMN leaderboard_contest_round TEXT NOT NULL DEFAULT 'pool'`,
  // Defaults to ON (1) so today's "everyone always shows" behavior doesn't
  // change the moment this ships — Ted turns it off later for a contest
  // where he'd rather non-advancing picks just disappear from public view.
  leaderboard_show_honorable_mentions: `ALTER TABLE settings ADD COLUMN leaderboard_show_honorable_mentions INTEGER NOT NULL DEFAULT 1`,
  // Manual on/off for embedding Kyle's live Twitch stream just under the
  // leaderboard entries. Deliberately independent of the automatic
  // live/offline detection in server/twitch.js -- Ted flips this himself
  // when he goes live and back off after, so fans never land on a dead
  // player between streams. Defaults to 0 (off).
  leaderboard_stream_embed_enabled: `ALTER TABLE settings ADD COLUMN leaderboard_stream_embed_enabled INTEGER NOT NULL DEFAULT 0`,
};
for (const [column, sql] of Object.entries(settingsMigrations)) {
  if (!settingsColumns.includes(column)) db.exec(sql);
}

// --- Migration: leaderboard_entries.thumbs_count (fan thumbs-up, gated by
// settings.leaderboard_thumbs_enabled). The leaderboard_entries table above
// already shipped with real rows before this column existed, so — same
// PRAGMA-check pattern as the other migrations here — check first rather
// than assuming a fresh table. ---
const leaderboardEntryColumns = db.prepare(`PRAGMA table_info(leaderboard_entries)`).all().map((c) => c.name);
if (!leaderboardEntryColumns.includes('thumbs_count')) {
  db.exec(`ALTER TABLE leaderboard_entries ADD COLUMN thumbs_count INTEGER NOT NULL DEFAULT 0`);
}

// --- Migration: contest rounds. Every entry starts in the open 'pool' and
// Kyle manually promotes it to 'top10' then 'top3' as the contest narrows —
// see settings.leaderboard_contest_round above for the separate "what's
// currently live" switch. stream_top_pick is a different, independent flag:
// Kyle's top-3-of-that-specific-stream pick, used to keep each day's results
// digestible — unrelated to which contest-wide round an entry has reached. ---
const leaderboardRoundColumns = db.prepare(`PRAGMA table_info(leaderboard_entries)`).all().map((c) => c.name);
if (!leaderboardRoundColumns.includes('round')) {
  db.exec(`ALTER TABLE leaderboard_entries ADD COLUMN round TEXT NOT NULL DEFAULT 'pool'`);
}
if (!leaderboardRoundColumns.includes('stream_top_pick')) {
  db.exec(`ALTER TABLE leaderboard_entries ADD COLUMN stream_top_pick INTEGER NOT NULL DEFAULT 0`);
}

// --- Migration: leaderboard_entries.audio_file -- the mp3 Kyle can attach
// to a submission so fans have something to actually listen to when they
// come back to vote (they don't remember songs by artist/title alone). Just
// a filename, same idea as tracks.audio_file -- the bytes live in
// data/submission-audio/ (server/uploads.js), a directory kept deliberately
// separate from data/audio/ (real purchasable masters) so the admin
// "Danger Zone" bulk-clear (server/admin-routes.js) can never risk touching
// paid product files. NULL = no mp3 attached, falls back to the `link`
// field on the public page. ---
const leaderboardAudioColumns = db.prepare(`PRAGMA table_info(leaderboard_entries)`).all().map((c) => c.name);
if (!leaderboardAudioColumns.includes('audio_file')) {
  db.exec(`ALTER TABLE leaderboard_entries ADD COLUMN audio_file TEXT`);
}

// --- Migration: projects.display_order (manual control over which release
// is "featured" and how the rest are ordered). SQLite has no "ADD COLUMN IF
// NOT EXISTS", so check first via PRAGMA before altering an existing table. ---
const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all().map((c) => c.name);
if (!projectColumns.includes('display_order')) {
  db.exec(`ALTER TABLE projects ADD COLUMN display_order INTEGER`);
  // Backfill so any existing rows keep the exact order they already had
  // (newest-first, same as before this column existed) — nothing jumps.
  db.exec(`
    UPDATE projects SET display_order = (
      SELECT rn FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn FROM projects
      ) ranked WHERE ranked.id = projects.id
    )
  `);
}
// --- Migration: projects.sold_out (added after the projects table already
// shipped with real rows in it — same PRAGMA-check pattern as display_order
// above). Existing rows default to 0 (not sold out), which is the only
// sane default since nothing was ever marked sold out before this existed. ---
if (!projectColumns.includes('sold_out')) {
  db.exec(`ALTER TABLE projects ADD COLUMN sold_out INTEGER NOT NULL DEFAULT 0`);
}
// --- Migration: projects.coming_soon -- lets Ted/Kyle publish a project to
// the storefront (art, title, description all visible) before it's actually
// buyable, e.g. showing the drop-day song ahead of time with a countdown and
// then flipping it live by hand ("Go Live") the moment the countdown ends.
// Independent of sold_out (opposite lifecycle stage, same "visible but can't
// buy" UI treatment under the hood). Defaults to 0 so no existing project
// changes behavior the moment this ships. ---
if (!projectColumns.includes('coming_soon')) {
  db.exec(`ALTER TABLE projects ADD COLUMN coming_soon INTEGER NOT NULL DEFAULT 0`);
}
// --- Migration: projects.release_mode -- how a coming-soon project leaves
// that state: 'manual' (Ted/Kyle click "Go Live") or 'auto' (flips live on
// its own once settings.countdown_target_at passes -- see sweepAutoReleases
// below). Irrelevant once coming_soon is 0. Defaults to 'manual' so nothing
// existing behaves differently the moment this ships. ---
if (!projectColumns.includes('release_mode')) {
  db.exec(`ALTER TABLE projects ADD COLUMN release_mode TEXT NOT NULL DEFAULT 'manual'`);
}

// --- Migration: orders.order_number (short human-friendly id — SDK-YYYYMMDD-XXXX
// — shown to fans/Ted instead of Stripe's long checkout session id). Added after
// the orders table already had real rows, so backfill existing ones using their
// own created_at date rather than leaving them blank. ---
const orderColumns = db.prepare(`PRAGMA table_info(orders)`).all().map((c) => c.name);
const ORDER_NUMBER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — easy to read aloud
function randomOrderSuffix(length = 4) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ORDER_NUMBER_ALPHABET[Math.floor(Math.random() * ORDER_NUMBER_ALPHABET.length)];
  }
  return out;
}
function generateOrderNumber(dateObj = new Date()) {
  const datePart = dateObj.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  // Collisions are astronomically unlikely at this store's volume, but a
  // cheap retry loop costs nothing and makes the uniqueness guarantee real
  // rather than assumed.
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `SDK-${datePart}-${randomOrderSuffix()}`;
    const exists = db.prepare(`SELECT 1 FROM orders WHERE order_number = ?`).get(candidate);
    if (!exists) return candidate;
  }
  // Should never happen, but fall back to a longer suffix rather than loop forever.
  return `SDK-${datePart}-${randomOrderSuffix(8)}`;
}
if (!orderColumns.includes('order_number')) {
  db.exec(`ALTER TABLE orders ADD COLUMN order_number TEXT`);
  const existingOrders = db.prepare(`SELECT id, created_at FROM orders WHERE order_number IS NULL`).all();
  const backfill = db.prepare(`UPDATE orders SET order_number = ? WHERE id = ?`);
  for (const row of existingOrders) {
    // created_at is stored as 'YYYY-MM-DD HH:MM:SS' (UTC, no timezone suffix) —
    // Date() parses that fine for our purposes (just need the date portion).
    backfill.run(generateOrderNumber(new Date(row.created_at)), row.id);
  }
}

// --- Migration: orders.reminder_sent_at -- tracks whether an abandoned-
// checkout reminder email has already gone out for this order, so the sweep
// in server/index.js never emails the same pending order twice. NULL = not
// sent yet; only meaningful while status is still 'pending'. ---
if (!orderColumns.includes('reminder_sent_at')) {
  db.exec(`ALTER TABLE orders ADD COLUMN reminder_sent_at TEXT`);
}

// --- New table: notify_signups -- fans who left their email on a Coming
// Soon project asking to be told the moment it's buyable. One row per
// (project, email) pair; UNIQUE stops a fan queuing up duplicate signups
// (and duplicate "it's live!" emails) if they submit the form twice.
// notified_at stays NULL until the go-live blast in admin-routes.js
// actually sends them the buy-link email. ---
db.exec(`
CREATE TABLE IF NOT EXISTS notify_signups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT,
  UNIQUE(project_id, email)
);
`);

function createOrder({ id, projectId, email, amountCents, currency }) {
  db.prepare(
    `INSERT OR IGNORE INTO orders (id, order_number, project_id, email, amount_cents, currency, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  ).run(id, generateOrderNumber(), projectId, email, amountCents, currency);
}

function markOrderPaid(id) {
  db.prepare(`UPDATE orders SET status = 'paid' WHERE id = ? AND status = 'pending'`).run(id);
}

function markOrderFulfilled(id) {
  db.prepare(
    `UPDATE orders SET status = 'fulfilled', fulfilled_at = datetime('now') WHERE id = ?`
  ).run(id);
}

// Abandoned-checkout recovery: orders that are still 'pending' (fan started
// Stripe Checkout but never finished paying), old enough that they've
// genuinely wandered off (not just mid-checkout right now), young enough
// that the original Stripe session is still safely inside its ~24h expiry
// window, and haven't had a reminder sent yet. minAgeHours/maxAgeHours are
// both in hours -- the sweep in server/index.js picks the actual window
// (see ABANDONED_MIN_AGE_HOURS/ABANDONED_MAX_AGE_HOURS there).
function listAbandonedOrders({ minAgeHours, maxAgeHours }) {
  return db
    .prepare(
      `SELECT * FROM orders
       WHERE status = 'pending'
         AND reminder_sent_at IS NULL
         AND created_at <= datetime('now', ?)
         AND created_at >= datetime('now', ?)`
    )
    .all(`-${minAgeHours} hours`, `-${maxAgeHours} hours`);
}

function markOrderReminderSent(id) {
  db.prepare(`UPDATE orders SET reminder_sent_at = datetime('now') WHERE id = ?`).run(id);
}

function getSettings() {
  return db.prepare(`SELECT * FROM settings WHERE id = 1`).get();
}

// Flips any coming-soon project set to auto-release live once the site's
// advertised countdown has actually passed. Tied to countdown_enabled (not
// just countdown_target_at) so this only fires against the currently-live
// public countdown, not a stale leftover date from an earlier drop. Called
// at the top of listAllProjects() (below) so it runs on every storefront and
// admin catalog read -- no separate scheduler needed for a store this size.
function sweepAutoReleases() {
  const settings = getSettings();
  if (!settings.countdown_enabled || !settings.countdown_target_at) return;
  const targetMs = new Date(settings.countdown_target_at).getTime();
  if (Number.isNaN(targetMs) || Date.now() < targetMs) return;
  db.prepare(
    `UPDATE projects SET coming_soon = 0, updated_at = datetime('now')
     WHERE coming_soon = 1 AND release_mode = 'auto'`
  ).run();
}

function updateSettings({
  saleNotificationEmails,
  confirmationMessage,
  headerTagline,
  countdownEnabled,
  countdownLabel,
  countdownTargetAt,
  leaderboardVisible,
  leaderboardSortMode,
  spotifyPlaylistId,
  leaderboardHeading,
  leaderboardSubheading,
  leaderboardThumbsEnabled,
  leaderboardThumbsLimitOne,
  leaderboardContestRound,
  leaderboardShowHonorableMentions,
  leaderboardStreamEmbedEnabled,
}) {
  const validRounds = ['pool', 'top10', 'top3', 'winner'];
  db.prepare(
    `UPDATE settings SET
       sale_notification_emails = ?,
       confirmation_message = ?,
       header_tagline = ?,
       countdown_enabled = ?,
       countdown_label = ?,
       countdown_target_at = ?,
       leaderboard_visible = ?,
       leaderboard_sort_mode = ?,
       spotify_playlist_id = ?,
       leaderboard_heading = ?,
       leaderboard_subheading = ?,
       leaderboard_thumbs_enabled = ?,
       leaderboard_thumbs_limit_one = ?,
       leaderboard_contest_round = ?,
       leaderboard_show_honorable_mentions = ?,
       leaderboard_stream_embed_enabled = ?
     WHERE id = 1`
  ).run(
    saleNotificationEmails,
    confirmationMessage,
    headerTagline,
    countdownEnabled ? 1 : 0,
    countdownLabel,
    countdownTargetAt || null,
    leaderboardVisible ? 1 : 0,
    leaderboardSortMode === 'rank' ? 'rank' : 'date',
    spotifyPlaylistId || '',
    leaderboardHeading,
    leaderboardSubheading,
    leaderboardThumbsEnabled ? 1 : 0,
    leaderboardThumbsLimitOne ? 1 : 0,
    validRounds.includes(leaderboardContestRound) ? leaderboardContestRound : 'pool',
    leaderboardShowHonorableMentions ? 1 : 0,
    leaderboardStreamEmbedEnabled ? 1 : 0
  );
  return getSettings();
}

function getOrder(id) {
  return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) || null;
}

// Sales reporting: only orders that actually collected money count as a
// "sale" — 'pending' means the fan started checkout but never completed
// payment, so those are excluded. Joins in the project's title/type since
// the report is meant to be read (and exported) without a second lookup.
// from/to are inclusive 'YYYY-MM-DD' strings; either can be omitted.
function listSalesForReport({ from, to } = {}) {
  const clauses = [`orders.status IN ('paid', 'fulfilled')`];
  const params = {};
  if (from) {
    clauses.push(`date(orders.created_at) >= date(@from)`);
    params.from = from;
  }
  if (to) {
    clauses.push(`date(orders.created_at) <= date(@to)`);
    params.to = to;
  }
  return db
    .prepare(
      `SELECT orders.order_number AS orderNumber, orders.id AS stripeSessionId,
              orders.created_at AS createdAt, orders.fulfilled_at AS fulfilledAt,
              orders.email AS email, orders.amount_cents AS amountCents, orders.currency AS currency,
              orders.status AS status, projects.title AS projectTitle, projects.type AS projectType
       FROM orders
       JOIN projects ON projects.id = orders.project_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY orders.created_at DESC`
    )
    .all(params);
}

function insertDownloadToken({ token, orderId, projectId, trackId, usesRemaining, expiresAt }) {
  db.prepare(
    `INSERT INTO download_tokens (token, order_id, project_id, track_id, uses_remaining, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(token, orderId, projectId, trackId, usesRemaining, expiresAt);
}

function getTokensForOrder(orderId) {
  return db.prepare(`SELECT * FROM download_tokens WHERE order_id = ?`).all(orderId);
}

function getToken(token) {
  return db.prepare(`SELECT * FROM download_tokens WHERE token = ?`).get(token) || null;
}

function decrementTokenUse(token) {
  db.prepare(
    `UPDATE download_tokens SET uses_remaining = uses_remaining - 1 WHERE token = ? AND uses_remaining > 0`
  ).run(token);
}

// --- Notify me: Coming Soon email signups ---

// INSERT OR IGNORE relies on the UNIQUE(project_id, email) constraint --
// resubmitting the same email on the same project is a silent no-op rather
// than a duplicate row (and a duplicate "it's live!" email later). Returns
// true only when this was a genuinely new signup, so the route can tell a
// fan "you're already on the list" instead of pretending it just worked.
function addNotifySignup({ projectId, email }) {
  const result = db
    .prepare(`INSERT OR IGNORE INTO notify_signups (id, project_id, email) VALUES (?, ?, ?)`)
    .run(uuidv4(), projectId, email);
  return result.changes > 0;
}

// Everyone still waiting to hear about this project going live -- used by
// the go-live email blast in admin-routes.js.
function listPendingNotifySignups(projectId) {
  return db.prepare(`SELECT * FROM notify_signups WHERE project_id = ? AND notified_at IS NULL`).all(projectId);
}

// How many fans are waiting on this Coming Soon project -- available for
// the admin UI to surface demand before a project goes live.
function countPendingNotifySignups(projectId) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM notify_signups WHERE project_id = ? AND notified_at IS NULL`)
    .get(projectId).n;
}

function markNotifySignupsNotified(projectId) {
  db.prepare(
    `UPDATE notify_signups SET notified_at = datetime('now') WHERE project_id = ? AND notified_at IS NULL`
  ).run(projectId);
}

// --- Catalog: projects ---

function listProjects() {
  sweepAutoReleases();
  return db.prepare(`SELECT * FROM projects ORDER BY display_order ASC, created_at DESC`).all();
}

function getProjectRow(id) {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) || null;
}

// New projects default to the very top (same spot a fresh upload has always
// landed in) — display_order just makes that a starting point instead of a
// fixed rule, so it can be overridden with reorderProject below.
function nextProjectDisplayOrder() {
  const row = db.prepare(`SELECT MIN(display_order) as minOrder FROM projects`).get();
  return (row.minOrder ?? 1) - 1;
}

function insertProject(p) {
  db.prepare(
    `INSERT INTO projects (id, title, type, release_year, cover_art_file, pricing_mode, fixed_price_cents, pwyw_min_per_track_cents, suggested_amounts_cents, description, sold_out, coming_soon, release_mode, display_order)
     VALUES (@id, @title, @type, @releaseYear, @coverArtFile, @pricingMode, @fixedPriceCents, @pwywMinPerTrackCents, @suggestedAmountsCents, @description, @soldOut, @comingSoon, @releaseMode, @displayOrder)`
  ).run({ soldOut: 0, comingSoon: 0, releaseMode: 'manual', ...p, displayOrder: nextProjectDisplayOrder() });
}

function updateProject(id, fields) {
  const current = getProjectRow(id);
  if (!current) return null;
  const merged = { ...current, ...fields, id };
  db.prepare(
    `UPDATE projects SET
       title = @title, type = @type, release_year = @release_year,
       cover_art_file = @cover_art_file, pricing_mode = @pricing_mode,
       fixed_price_cents = @fixed_price_cents, pwyw_min_per_track_cents = @pwyw_min_per_track_cents,
       suggested_amounts_cents = @suggested_amounts_cents, description = @description,
       sold_out = @sold_out, coming_soon = @coming_soon, release_mode = @release_mode,
       updated_at = datetime('now')
     WHERE id = @id`
  ).run(merged);
  return getProjectRow(id);
}

function deleteProject(id) {
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id); // tracks cascade via FK
}

function swapProjectOrder(idA, idB) {
  const a = getProjectRow(idA);
  const b = getProjectRow(idB);
  if (!a || !b) return;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE projects SET display_order = ? WHERE id = ?`).run(b.display_order, a.id);
    db.prepare(`UPDATE projects SET display_order = ? WHERE id = ?`).run(a.display_order, b.id);
  });
  tx();
}

// --- Catalog: tracks ---

function listTracksForProject(projectId) {
  return db.prepare(`SELECT * FROM tracks WHERE project_id = ? ORDER BY track_number ASC`).all(projectId);
}

function getTrackRow(id) {
  return db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(id) || null;
}

function nextTrackNumber(projectId) {
  const row = db.prepare(`SELECT MAX(track_number) as maxNum FROM tracks WHERE project_id = ?`).get(projectId);
  return (row.maxNum || 0) + 1;
}

function insertTrack(t) {
  db.prepare(
    `INSERT INTO tracks (id, project_id, track_number, title, audio_file, preview_audio_file, duration_seconds, released)
     VALUES (@id, @projectId, @trackNumber, @title, @audioFile, @previewAudioFile, @durationSeconds, @released)`
  ).run(t);
}

function updateTrack(id, fields) {
  const current = getTrackRow(id);
  if (!current) return null;
  const merged = { ...current, ...fields, id };
  db.prepare(
    `UPDATE tracks SET
       track_number = @track_number, title = @title, audio_file = @audio_file,
       preview_audio_file = @preview_audio_file, duration_seconds = @duration_seconds,
       released = @released
     WHERE id = @id`
  ).run(merged);
  return getTrackRow(id);
}

function deleteTrack(id) {
  db.prepare(`DELETE FROM tracks WHERE id = ?`).run(id);
}

function swapTrackOrder(trackIdA, trackIdB) {
  const a = getTrackRow(trackIdA);
  const b = getTrackRow(trackIdB);
  if (!a || !b) return;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE tracks SET track_number = ? WHERE id = ?`).run(b.track_number, a.id);
    db.prepare(`UPDATE tracks SET track_number = ? WHERE id = ?`).run(a.track_number, b.id);
  });
  tx();
}

// --- Feature Contest leaderboard ---
// Same shape as the projects/tracks patterns above: a manual rank_position
// with a swap-based reorder, plus a separate stream_date sort for today's
// actual (chronological) contest. Both orderings are always kept in sync —
// which one the public page uses is purely a settings.leaderboard_sort_mode
// read at request time, not a data difference.

// Admin editing view: always by rank_position, so the up/down controls make
// sense regardless of which sort mode is currently live on the public page.
function listLeaderboardEntriesForAdmin() {
  return db.prepare(`SELECT * FROM leaderboard_entries ORDER BY rank_position ASC`).all();
}

// Public view: sortMode is whatever settings.leaderboard_sort_mode currently
// is — 'date' (today's contest, newest stream first) or 'rank' (future use).
function listLeaderboardEntriesPublic(sortMode) {
  const order = sortMode === 'rank' ? 'rank_position ASC' : 'stream_date DESC, created_at DESC';
  return db.prepare(`SELECT * FROM leaderboard_entries ORDER BY ${order}`).all();
}

function getLeaderboardEntryRow(id) {
  return db.prepare(`SELECT * FROM leaderboard_entries WHERE id = ?`).get(id) || null;
}

// New entries default to the bottom of the rank order — same idea as
// nextProjectDisplayOrder, just counting up instead of down since there's no
// "featured" slot here to protect.
function nextLeaderboardRankPosition() {
  const row = db.prepare(`SELECT MAX(rank_position) as maxOrder FROM leaderboard_entries`).get();
  return (row.maxOrder ?? 0) + 1;
}

function insertLeaderboardEntry({ id, artist, songTitle, streamDate, link, audioFile }) {
  db.prepare(
    `INSERT INTO leaderboard_entries (id, artist, song_title, stream_date, link, audio_file, rank_position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, artist, songTitle, streamDate, link || null, audioFile || null, nextLeaderboardRankPosition());
  return getLeaderboardEntryRow(id);
}

// audioFile here is always the FINAL value the caller wants stored (a new
// filename, the existing one unchanged, or null to clear it) -- the
// route in admin-routes.js works out which of those applies (new upload vs.
// keep vs. explicit remove) since that's a request-shape decision, not a
// database one.
function updateLeaderboardEntry(id, { artist, songTitle, streamDate, link, audioFile }) {
  const current = getLeaderboardEntryRow(id);
  if (!current) return null;
  db.prepare(
    `UPDATE leaderboard_entries SET artist = ?, song_title = ?, stream_date = ?, link = ?, audio_file = ? WHERE id = ?`
  ).run(artist, songTitle, streamDate, link || null, audioFile || null, id);
  return getLeaderboardEntryRow(id);
}

// Bulk "clear audio only" for the admin Danger Zone -- wipes the DB column
// for every entry that has one. Deleting the actual files on disk is the
// caller's job (server/admin-routes.js), same division of labor as
// deleteLeaderboardEntry below: db.js only ever touches the database.
function clearAllLeaderboardAudio() {
  db.prepare(`UPDATE leaderboard_entries SET audio_file = NULL WHERE audio_file IS NOT NULL`).run();
}

// Bulk "delete everything" for the admin Danger Zone -- a distinct, more
// severe action from clearAllLeaderboardAudio above (Ted wants these as two
// separate buttons): this removes the entries themselves, not just their
// audio. Same division of labor: file cleanup happens in admin-routes.js
// before this runs.
function deleteAllLeaderboardEntries() {
  db.prepare(`DELETE FROM leaderboard_entries`).run();
}

function deleteLeaderboardEntry(id) {
  db.prepare(`DELETE FROM leaderboard_entries WHERE id = ?`).run(id);
}

function swapLeaderboardRank(idA, idB) {
  const a = getLeaderboardEntryRow(idA);
  const b = getLeaderboardEntryRow(idB);
  if (!a || !b) return;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE leaderboard_entries SET rank_position = ? WHERE id = ?`).run(b.rank_position, a.id);
    db.prepare(`UPDATE leaderboard_entries SET rank_position = ? WHERE id = ?`).run(a.rank_position, b.id);
  });
  tx();
}

// Only one entry is ever "the" Feature Winner — clear any existing badge
// before setting the new one so the public page never has to reason about
// (or accidentally render) more than one at a time. Also advances the
// contest-wide round to 'winner' in the same transaction — marking a winner
// IS the final round, so there's no separate step to remember. Clearing a
// winner deliberately does NOT step the round back down; that's Ted's call
// to make explicitly via the round selector if he needs to undo further.
function setLeaderboardWinner(id) {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE leaderboard_entries SET is_winner = 0 WHERE is_winner = 1`).run();
    db.prepare(`UPDATE leaderboard_entries SET is_winner = 1 WHERE id = ?`).run(id);
    db.prepare(`UPDATE settings SET leaderboard_contest_round = 'winner' WHERE id = 1`).run();
  });
  tx();
  return getLeaderboardEntryRow(id);
}

function clearLeaderboardWinner() {
  db.prepare(`UPDATE leaderboard_entries SET is_winner = 0 WHERE is_winner = 1`).run();
}

// Contest-wide round progression for a single entry — Kyle's manual call,
// same spirit as setLeaderboardWinner above but for the earlier rounds.
const VALID_ENTRY_ROUNDS = ['pool', 'top10', 'top3'];
function setLeaderboardEntryRound(id, round) {
  if (!VALID_ENTRY_ROUNDS.includes(round)) return getLeaderboardEntryRow(id);
  db.prepare(`UPDATE leaderboard_entries SET round = ? WHERE id = ?`).run(round, id);
  return getLeaderboardEntryRow(id);
}

// Kyle's top-3-of-that-specific-stream flag — independent of the
// contest-wide round above. No hard cap enforced here; the "3" is a
// self-managed guideline, not a rule the backend polices.
function setLeaderboardStreamTopPick(id, value) {
  db.prepare(`UPDATE leaderboard_entries SET stream_top_pick = ? WHERE id = ?`).run(value ? 1 : 0, id);
  return getLeaderboardEntryRow(id);
}

// Fan thumbs-up. A single atomic UPDATE (no read-then-write) so two fans
// clicking at the same instant can't stomp on each other's count. Only
// meant to be called once the caller has already checked
// settings.leaderboard_visible and settings.leaderboard_thumbs_enabled —
// this function itself doesn't know about either. There's no per-fan vote
// limit on the server (no login system to hang one on); the public page
// enforces "once per browser" client-side via localStorage, which is a
// nice-to-have, not fraud-proofing — fine for a fun engagement number,
// not something anything else depends on.
function incrementLeaderboardThumbs(id) {
  const result = db.prepare(`UPDATE leaderboard_entries SET thumbs_count = thumbs_count + 1 WHERE id = ?`).run(id);
  if (result.changes === 0) return null;
  return getLeaderboardEntryRow(id);
}

module.exports = {
  db,
  sweepAutoReleases,
  listProjects,
  getProjectRow,
  insertProject,
  updateProject,
  deleteProject,
  swapProjectOrder,
  listTracksForProject,
  getTrackRow,
  nextTrackNumber,
  insertTrack,
  updateTrack,
  deleteTrack,
  swapTrackOrder,
  createOrder,
  markOrderPaid,
  markOrderFulfilled,
  listAbandonedOrders,
  markOrderReminderSent,
  getSettings,
  updateSettings,
  getOrder,
  listSalesForReport,
  insertDownloadToken,
  getTokensForOrder,
  getToken,
  decrementTokenUse,
  addNotifySignup,
  listPendingNotifySignups,
  countPendingNotifySignups,
  markNotifySignupsNotified,
  listLeaderboardEntriesForAdmin,
  listLeaderboardEntriesPublic,
  getLeaderboardEntryRow,
  insertLeaderboardEntry,
  updateLeaderboardEntry,
  deleteLeaderboardEntry,
  clearAllLeaderboardAudio,
  deleteAllLeaderboardEntries,
  swapLeaderboardRank,
  setLeaderboardWinner,
  clearLeaderboardWinner,
  setLeaderboardEntryRound,
  setLeaderboardStreamTopPick,
  incrementLeaderboardThumbs,
};
