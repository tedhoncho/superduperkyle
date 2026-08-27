const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const EXPIRY_HOURS = parseInt(process.env.DOWNLOAD_LINK_EXPIRY_HOURS || '168', 10); // 7 days
const MAX_USES = parseInt(process.env.DOWNLOAD_MAX_USES || '5', 10);

// Creates one download token per purchased track (released tracks only —
// unreleased/locked tracks are never included even if somehow requested).
function issueTokensForOrder({ orderId, project }) {
  const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
  const tokens = [];

  for (const track of project.tracks) {
    if (!track.released) continue;
    const token = uuidv4();
    db.insertDownloadToken({
      token,
      orderId,
      projectId: project.id,
      trackId: track.id,
      usesRemaining: MAX_USES,
      expiresAt,
    });
    tokens.push({ token, track });
  }

  return tokens;
}

function validateToken(token) {
  const row = db.getToken(token);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.uses_remaining <= 0) return { ok: false, reason: 'exhausted' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, row };
}

module.exports = { issueTokensForOrder, validateToken, EXPIRY_HOURS, MAX_USES };
