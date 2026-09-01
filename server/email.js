// Sends the post-purchase download email via Resend (https://resend.com).
// Swapping providers (SendGrid, Postmark, etc.) only means rewriting this
// one file — nothing else in the app calls an email API directly.

const { Resend } = require('resend');
const db = require('./db');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Settings entered through the admin Notifications tab are plain text that
// ends up inside an HTML email — escape it so a stray < or & from Ted/Kyle
// typing normally (e.g. "songs & stories") can't break the email's layout.
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function downloadLinksHtml(baseUrl, tokens) {
  const items = tokens
    .map(
      ({ token, track }) =>
        `<li style="margin-bottom:8px;"><a href="${baseUrl}/api/download/${token}" style="color:#111;font-weight:600;">Download: ${track.title}</a></li>`
    )
    .join('');
  return `<ul style="list-style:none;padding:0;">${items}</ul>`;
}

async function sendDownloadEmail({ to, artistName, projectTitle, baseUrl, tokens, expiryHours }) {
  if (!resend) {
    console.warn('[email] RESEND_API_KEY not set — skipping email send. Would have sent to:', to);
    return { skipped: true };
  }

  const expiryDays = Math.round(expiryHours / 24);
  const settings = db.getSettings();
  // Ted/Kyle's custom note from the admin Notifications tab, falling back to
  // the original generic line if they haven't set one yet.
  const message = settings.confirmation_message
    ? escapeHtml(settings.confirmation_message)
    : `Here's your download for <strong>${escapeHtml(projectTitle)}</strong>.`;

  return resend.emails.send({
    from: process.env.EMAIL_FROM || `${artistName} <onboarding@resend.dev>`,
    to,
    subject: `Your download: ${projectTitle}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="margin-bottom:4px;">Thanks for supporting ${escapeHtml(artistName)}!</h2>
        <p style="color:#555;">${message}</p>
        ${downloadLinksHtml(baseUrl, tokens)}
        <p style="margin:16px 0;padding:12px 14px;background:#fdf1f7;border:2px solid #eb66ae;border-radius:8px;">
          <a href="${baseUrl}/guides/add-song-to-spotify-guide.pdf" style="color:#111;font-weight:700;text-decoration:none;">&#128196; New to this? Get the quick guide to adding your song to Spotify &rarr;</a>
        </p>
        <p style="color:#888;font-size:13px;">Links expire in ${expiryDays} day${expiryDays === 1 ? '' : 's'} and can be used up to a few times, so grab your files and save them somewhere safe.</p>
      </div>
    `,
  });
}

// A short internal "someone bought this" alert, sent only to the store
// owner(s) — deliberately separate from sendDownloadEmail above rather than
// a literal CC on the fan's email, so the fan's inbox stays clean (no
// internal addresses visible in the headers) and this can carry
// order/admin details the fan doesn't need to see. Recipients come from the
// admin Notifications tab (settings.sale_notification_emails), comma-
// separated, so this can go to multiple people without any code changes.
async function sendSaleNotification({ artistName, projectTitle, amountCents, currency, customerEmail, orderId }) {
  const settings = db.getSettings();
  const to = (settings.sale_notification_emails || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!to.length) {
    // Previously a silent no-op — logged now because "nothing happened" and
    // "it broke" looked identical from the outside. This is the one line
    // that tells them apart: it only prints when the Notifications tab
    // genuinely has no recipients saved at the moment a sale comes in.
    console.log(
      `[email] sale notification skipped — no recipients saved in the admin Notifications tab (raw value: ${JSON.stringify(
        settings.sale_notification_emails
      )}).`
    );
    return { skipped: true };
  }

  if (!resend) {
    console.warn('[email] RESEND_API_KEY not set — skipping sale notification.');
    return { skipped: true };
  }

  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(
    amountCents / 100
  );

  const result = await resend.emails.send({
    from: process.env.EMAIL_FROM || `${artistName} <onboarding@resend.dev>`,
    to,
    subject: `New sale: ${projectTitle} (${amount})`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="margin-bottom:4px;">New sale</h2>
        <ul style="list-style:none;padding:0;color:#333;line-height:1.9;">
          <li><strong>Project:</strong> ${escapeHtml(projectTitle)}</li>
          <li><strong>Amount:</strong> ${amount}</li>
          <li><strong>Customer:</strong> ${escapeHtml(customerEmail)}</li>
          <li><strong>Order #:</strong> ${escapeHtml(orderId)}</li>
        </ul>
      </div>
    `,
  });
  console.log(`[email] sale notification sent to ${to.join(', ')} for order ${orderId}.`);
  return result;
}

module.exports = { sendDownloadEmail, sendSaleNotification };
