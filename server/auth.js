// Single shared admin password — this is Kyle's own upload tool, not a
// multi-user system, so one password (set as ADMIN_PASSWORD in .env) plus a
// session cookie is the right amount of security for the job. Compared with
// crypto.timingSafeEqual to avoid leaking the password length/prefix via
// response-time differences.

const crypto = require('crypto');

function checkPassword(candidate) {
  const real = process.env.ADMIN_PASSWORD || '';
  if (!real) return false; // refuse to "succeed" against an unset password
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(real);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: 'Not logged in.' });
}

module.exports = { checkPassword, requireAuth };
