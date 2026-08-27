// Sends the post-purchase download email via Resend (https://resend.com).
// Swapping providers (SendGrid, Postmark, etc.) only means rewriting this
// one file — nothing else in the app calls an email API directly.

const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

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

  return resend.emails.send({
    from: process.env.EMAIL_FROM || `${artistName} <onboarding@resend.dev>`,
    to,
    subject: `Your download: ${projectTitle}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="margin-bottom:4px;">Thanks for supporting ${artistName}!</h2>
        <p style="color:#555;">Here's your download for <strong>${projectTitle}</strong>.</p>
        ${downloadLinksHtml(baseUrl, tokens)}
        <p style="color:#888;font-size:13px;">Links expire in ${expiryDays} day${expiryDays === 1 ? '' : 's'} and can be used up to a few times, so grab your files and save them somewhere safe.</p>
      </div>
    `,
  });
}

module.exports = { sendDownloadEmail };
