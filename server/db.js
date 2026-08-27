// Lightweight SQLite store for orders and download tokens.
// SQLite (file-based) is plenty for an indie-artist direct store's order volume,
// and needs zero external services to run. If this ever needs to run across
// multiple server instances at once, swap this file for a Postgres client —
// the rest of the app only calls the functions exported below.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'db', 'store.sqlite3');
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
`);

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

function getOrder(id) {
  return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) || null;
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
  return db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all();
}

function getProjectRow(id) {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) || null;
}

function insertProject(p) {
  db.prepare(
    `INSERT INTO projects (id, title, type, release_year, cover_art_file, pricing_mode, fixed_price_cents, pwyw_min_per_track_cents, suggested_amounts_cents, description)
     VALUES (@id, @title, @type, @releaseYear, @coverArtFile, @pricingMode, @fixedPriceCents, @pwywMinPerTrackCents, @suggestedAmountsCents, @description)`
  ).run(p);
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
       updated_at = datetime('now')
     WHERE id = @id`
  ).run(merged);
  return getProjectRow(id);
}

function deleteProject(id) {
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id); // tracks cascade via FK
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
  getOrder,
  insertDownloadToken,
  getTokensForOrder,
  getToken,
  decrementTokenUse,
};
