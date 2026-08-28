// Lightweight SQLite store for orders and download tokens.
// SQLite (file-based) is plenty for an indie-artist direct store's order volume,
// and needs zero external services to run. If this ever needs to run across
// multiple server instances at once, swap this file for a Postgres client —
// the rest of the app only calls the functions exported below.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

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
  id TEXT PRIMARY KEY,               -- Stripe Checkout Session id
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
};
for (const [column, sql] of Object.entries(settingsMigrations)) {
  if (!settingsColumns.includes(column)) db.exec(sql);
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

function createOrder({ id, projectId, email, amountCents, currency }) {
  db.prepare(
    `INSERT OR IGNORE INTO orders (id, project_id, email, amount_cents, currency, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`
  ).run(id, projectId, email, amountCents, currency);
}

function markOrderPaid(id) {
  db.prepare(`UPDATE orders SET status = 'paid' WHERE id = ? AND status = 'pending'`).run(id);
}

function markOrderFulfilled(id) {
  db.prepare(
    `UPDATE orders SET status = 'fulfilled', fulfilled_at = datetime('now') WHERE id = ?`
  ).run(id);
}

function getSettings() {
  return db.prepare(`SELECT * FROM settings WHERE id = 1`).get();
}

function updateSettings({
  saleNotificationEmails,
  confirmationMessage,
  headerTagline,
  countdownEnabled,
  countdownLabel,
  countdownTargetAt,
}) {
  db.prepare(
    `UPDATE settings SET
       sale_notification_emails = ?,
       confirmation_message = ?,
       header_tagline = ?,
       countdown_enabled = ?,
       countdown_label = ?,
       countdown_target_at = ?
     WHERE id = 1`
  ).run(
    saleNotificationEmails,
    confirmationMessage,
    headerTagline,
    countdownEnabled ? 1 : 0,
    countdownLabel,
    countdownTargetAt || null
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
      `SELECT orders.id AS orderId, orders.created_at AS createdAt, orders.fulfilled_at AS fulfilledAt,
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

// --- Catalog: projects ---

function listProjects() {
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
    `INSERT INTO projects (id, title, type, release_year, cover_art_file, pricing_mode, fixed_price_cents, pwyw_min_per_track_cents, suggested_amounts_cents, description, sold_out, display_order)
     VALUES (@id, @title, @type, @releaseYear, @coverArtFile, @pricingMode, @fixedPriceCents, @pwywMinPerTrackCents, @suggestedAmountsCents, @description, @soldOut, @displayOrder)`
  ).run({ soldOut: 0, ...p, displayOrder: nextProjectDisplayOrder() });
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
       sold_out = @sold_out,
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

module.exports = {
  db,
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
  getSettings,
  updateSettings,
  getOrder,
  listSalesForReport,
  insertDownloadToken,
  getTokensForOrder,
  getToken,
  decrementTokenUse,
};
