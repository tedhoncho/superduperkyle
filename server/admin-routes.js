const express = require('express');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const catalog = require('./catalog');
const storage = require('./storage');
const { checkPassword, requireAuth } = require('./auth');
const { audioUpload, imageUpload, extOf, AUDIO_DIR, ART_DIR } = require('./uploads');
const { getDurationSeconds, generatePreviewClip } = require('./media');
const { slugId } = require('./ids');

const router = express.Router();

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error('[admin] failed to delete file:', filePath, err.message);
  }
}

// Auto-derive pay-what-you-want quick-pick amounts from the minimum, so
// Kyle never has to fill in a "suggested amounts" field himself.
function deriveSuggestedAmounts(minCents) {
  return [minCents, minCents * 2, minCents * 3, minCents * 5].join('|');
}

function projectFieldsFromBody(body) {
  const pricingMode = body.pricingMode === 'pwyw' ? 'pwyw' : 'fixed';
  const fixedPriceCents = pricingMode === 'fixed' ? Math.round(parseFloat(body.price || '0') * 100) : null;
  const pwywMinPerTrackCents = pricingMode === 'pwyw' ? Math.round(parseFloat(body.price || '0') * 100) : null;

  return {
    title: (body.title || '').trim(),
    type: ['single', 'ep', 'album'].includes(body.type) ? body.type : 'single',
    release_year: body.releaseYear || null,
    pricing_mode: pricingMode,
    fixed_price_cents: fixedPriceCents,
    pwyw_min_per_track_cents: pwywMinPerTrackCents,
    suggested_amounts_cents: pricingMode === 'pwyw' ? deriveSuggestedAmounts(pwywMinPerTrackCents) : '',
    description: body.description || '',
    sold_out: body.soldOut === true || body.soldOut === 'true' ? 1 : 0,
    coming_soon: body.comingSoon === true || body.comingSoon === 'true' ? 1 : 0,
    release_mode: body.releaseMode === 'auto' ? 'auto' : 'manual',
  };
}

// --- Auth ---

router.post('/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD is not set on the server — the site owner needs to configure it.' });
  }
  if (!checkPassword(req.body?.password)) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  req.session.authenticated = true;
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/session', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// Everything below this line requires a logged-in session.
router.use(requireAuth);

// --- Projects ---

router.get('/projects', (req, res) => {
  res.json({ projects: catalog.listAllProjects() });
});

router.post('/projects', (req, res) => {
  const fields = projectFieldsFromBody(req.body || {});
  if (!fields.title) return res.status(400).json({ error: 'Give it a title.' });
  if (fields.pricing_mode === 'fixed' && !fields.fixed_price_cents) {
    return res.status(400).json({ error: 'Set a price.' });
  }
  if (fields.pricing_mode === 'pwyw' && !fields.pwyw_min_per_track_cents) {
    return res.status(400).json({ error: 'Set a minimum price per song.' });
  }

  const id = slugId(fields.title);
  db.insertProject({
    id,
    title: fields.title,
    type: fields.type,
    releaseYear: fields.release_year,
    coverArtFile: null,
    pricingMode: fields.pricing_mode,
    fixedPriceCents: fields.fixed_price_cents,
    pwywMinPerTrackCents: fields.pwyw_min_per_track_cents,
    suggestedAmountsCents: fields.suggested_amounts_cents,
    description: fields.description,
    soldOut: fields.sold_out,
    comingSoon: fields.coming_soon,
    releaseMode: fields.release_mode,
  });

  res.json({ project: catalog.getProject(id) });
});

router.put('/projects/:id', (req, res) => {
  const existing = db.getProjectRow(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found.' });

  const fields = projectFieldsFromBody(req.body || {});
  if (!fields.title) return res.status(400).json({ error: 'Give it a title.' });
  if (fields.pricing_mode === 'fixed' && !fields.fixed_price_cents) {
    return res.status(400).json({ error: 'Set a price.' });
  }
  if (fields.pricing_mode === 'pwyw' && !fields.pwyw_min_per_track_cents) {
    return res.status(400).json({ error: 'Set a minimum price per song.' });
  }

  db.updateProject(req.params.id, fields);
  res.json({ project: catalog.getProject(req.params.id) });
});

router.delete('/projects/:id', async (req, res) => {
  const project = catalog.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  if (project.coverArtFile) safeUnlink(path.join(ART_DIR, project.coverArtFile));
  for (const track of project.tracks) {
    if (track.audioFile) await storage.deleteAudioFile(track.audioFile);
    if (track.previewAudioFile) await storage.deleteAudioFile(track.previewAudioFile);
  }

  db.deleteProject(req.params.id);
  res.json({ ok: true });
});

router.post('/projects/:id/reorder', (req, res) => {
  const project = catalog.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const siblings = catalog.listAllProjects();
  const index = siblings.findIndex((p) => p.id === project.id);
  const targetIndex = req.body.direction === 'up' ? index - 1 : index + 1;

  if (targetIndex < 0 || targetIndex >= siblings.length) {
    return res.json({ projects: siblings }); // already at the end, no-op
  }

  db.swapProjectOrder(project.id, siblings[targetIndex].id);
  res.json({ projects: catalog.listAllProjects() });
});

// --- Notification & storefront settings ---
// Non-secret, day-to-day config Ted/Kyle would want to tweak themselves —
// deliberately kept separate from things like RESEND_API_KEY or the Stripe
// keys, which stay as Railway env vars since those are credentials, not
// content an admin-editable web form should be handling.

function settingsToJson(row) {
  return {
    saleNotificationEmails: row.sale_notification_emails,
    confirmationMessage: row.confirmation_message,
    headerTagline: row.header_tagline,
    countdownEnabled: !!row.countdown_enabled,
    countdownLabel: row.countdown_label,
    // Stored in SQLite as an ISO string (UTC) — passed straight through so the
    // admin form and public storefront both just deal in ISO/epoch time.
    countdownTargetAt: row.countdown_target_at,
    leaderboardVisible: !!row.leaderboard_visible,
    leaderboardSortMode: row.leaderboard_sort_mode,
    spotifyPlaylistId: row.spotify_playlist_id || '',
    leaderboardHeading: row.leaderboard_heading,
    leaderboardSubheading: row.leaderboard_subheading,
    leaderboardThumbsEnabled: !!row.leaderboard_thumbs_enabled,
    leaderboardThumbsLimitOne: !!row.leaderboard_thumbs_limit_one,
    leaderboardContestRound: row.leaderboard_contest_round || 'pool',
    leaderboardShowHonorableMentions: !!row.leaderboard_show_honorable_mentions,
  };
}

// Kyle/Ted will paste whatever Spotify gives them to copy — the normal share
// link, the embed code's src URL, or (via the embed "Copy playlist link")
// just the raw ID — rather than hunt for one specific format. Pull the
// playlist ID out of any of those; returns '' for an intentionally-cleared
// field, or null if something was entered but couldn't be understood.
function extractSpotifyPlaylistId(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return '';
  const urlMatch = trimmed.match(/open\.spotify\.com\/(?:embed\/)?playlist\/([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9]{10,30}$/.test(trimmed)) return trimmed; // already just the bare ID
  return null;
}

router.get('/settings', (req, res) => {
  res.json({ settings: settingsToJson(db.getSettings()) });
});

router.put('/settings', (req, res) => {
  // The Notifications tab and the Site tab each save independently and only
  // send the fields they own — merge onto the existing row rather than
  // overwriting it wholesale, so saving one tab can't blank out the other's
  // fields (e.g. saving the tagline shouldn't erase the notification emails).
  const current = db.getSettings();

  const saleNotificationEmails =
    req.body.saleNotificationEmails !== undefined ? req.body.saleNotificationEmails.trim() : current.sale_notification_emails;
  const confirmationMessage =
    req.body.confirmationMessage !== undefined ? req.body.confirmationMessage.trim() : current.confirmation_message;
  const headerTagline = req.body.headerTagline !== undefined ? req.body.headerTagline.trim() : current.header_tagline;
  const countdownLabel = req.body.countdownLabel !== undefined ? req.body.countdownLabel.trim() : current.countdown_label;
  const countdownEnabled =
    req.body.countdownEnabled !== undefined
      ? req.body.countdownEnabled === true || req.body.countdownEnabled === 'true'
      : !!current.countdown_enabled;
  const countdownTargetAt =
    req.body.countdownTargetAt !== undefined ? (req.body.countdownTargetAt || '').trim() : current.countdown_target_at || '';
  const leaderboardVisible =
    req.body.leaderboardVisible !== undefined
      ? req.body.leaderboardVisible === true || req.body.leaderboardVisible === 'true'
      : !!current.leaderboard_visible;
  const leaderboardSortMode =
    req.body.leaderboardSortMode !== undefined ? req.body.leaderboardSortMode : current.leaderboard_sort_mode;
  const leaderboardHeading =
    req.body.leaderboardHeading !== undefined ? req.body.leaderboardHeading.trim() : current.leaderboard_heading;
  const leaderboardSubheading =
    req.body.leaderboardSubheading !== undefined ? req.body.leaderboardSubheading.trim() : current.leaderboard_subheading;
  const leaderboardThumbsEnabled =
    req.body.leaderboardThumbsEnabled !== undefined
      ? req.body.leaderboardThumbsEnabled === true || req.body.leaderboardThumbsEnabled === 'true'
      : !!current.leaderboard_thumbs_enabled;
  const leaderboardThumbsLimitOne =
    req.body.leaderboardThumbsLimitOne !== undefined
      ? req.body.leaderboardThumbsLimitOne === true || req.body.leaderboardThumbsLimitOne === 'true'
      : !!current.leaderboard_thumbs_limit_one;
  const validContestRounds = ['pool', 'top10', 'top3', 'winner'];
  const leaderboardContestRound =
    req.body.leaderboardContestRound !== undefined && validContestRounds.includes(req.body.leaderboardContestRound)
      ? req.body.leaderboardContestRound
      : current.leaderboard_contest_round;
  const leaderboardShowHonorableMentions =
    req.body.leaderboardShowHonorableMentions !== undefined
      ? req.body.leaderboardShowHonorableMentions === true || req.body.leaderboardShowHonorableMentions === 'true'
      : !!current.leaderboard_show_honorable_mentions;

  let spotifyPlaylistId = current.spotify_playlist_id || '';
  if (req.body.spotifyPlaylistLink !== undefined) {
    const parsed = extractSpotifyPlaylistId(req.body.spotifyPlaylistLink);
    if (parsed === null) {
      return res.status(400).json({ error: "That doesn't look like a Spotify playlist link — paste the share link or embed link Spotify gives you." });
    }
    spotifyPlaylistId = parsed;
  }

  if (countdownEnabled && !countdownTargetAt) {
    return res.status(400).json({ error: 'Set a target date/time before turning the countdown on.' });
  }
  if (countdownTargetAt && Number.isNaN(Date.parse(countdownTargetAt))) {
    return res.status(400).json({ error: "That countdown date/time didn't parse — try picking it again." });
  }

  const settings = db.updateSettings({
    saleNotificationEmails,
    confirmationMessage,
    headerTagline,
    countdownEnabled,
    countdownLabel,
    countdownTargetAt: countdownTargetAt || null,
    leaderboardVisible,
    leaderboardSortMode,
    spotifyPlaylistId,
    leaderboardHeading,
    leaderboardSubheading,
    leaderboardThumbsEnabled,
    leaderboardThumbsLimitOne,
    leaderboardContestRound,
    leaderboardShowHonorableMentions,
  });
  res.json({ settings: settingsToJson(settings) });
});

// --- Feature Contest leaderboard ---
// Manual, hand-curated list — Ted/Kyle add one entry per stream pick. No
// external data source (Nero.fan/Throne aren't wired up here), matching how
// everything else on this site already works.

function leaderboardEntryToJson(row) {
  return {
    id: row.id,
    artist: row.artist,
    songTitle: row.song_title,
    streamDate: row.stream_date,
    link: row.link || '',
    isWinner: !!row.is_winner,
    rankPosition: row.rank_position,
    thumbsCount: row.thumbs_count,
    round: row.round || 'pool',
    streamTopPick: !!row.stream_top_pick,
  };
}

router.get('/leaderboard', (req, res) => {
  res.json({ entries: db.listLeaderboardEntriesForAdmin().map(leaderboardEntryToJson) });
});

router.post('/leaderboard', (req, res) => {
  const artist = (req.body.artist || '').trim();
  const songTitle = (req.body.songTitle || '').trim();
  const streamDate = (req.body.streamDate || '').trim();
  const link = (req.body.link || '').trim();

  if (!artist) return res.status(400).json({ error: 'Give it an artist name.' });
  if (!songTitle) return res.status(400).json({ error: 'Give it a song title.' });
  if (!streamDate || Number.isNaN(Date.parse(streamDate))) {
    return res.status(400).json({ error: 'Pick the stream date this was reviewed on.' });
  }

  const entry = db.insertLeaderboardEntry({ id: slugId(`${artist}-${songTitle}`), artist, songTitle, streamDate, link });
  res.json({ entry: leaderboardEntryToJson(entry) });
});

router.put('/leaderboard/:id', (req, res) => {
  const existing = db.getLeaderboardEntryRow(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Entry not found.' });

  const artist = (req.body.artist || '').trim();
  const songTitle = (req.body.songTitle || '').trim();
  const streamDate = (req.body.streamDate || '').trim();
  const link = (req.body.link || '').trim();

  if (!artist) return res.status(400).json({ error: 'Give it an artist name.' });
  if (!songTitle) return res.status(400).json({ error: 'Give it a song title.' });
  if (!streamDate || Number.isNaN(Date.parse(streamDate))) {
    return res.status(400).json({ error: 'Pick the stream date this was reviewed on.' });
  }

  const entry = db.updateLeaderboardEntry(req.params.id, { artist, songTitle, streamDate, link });
  res.json({ entry: leaderboardEntryToJson(entry) });
});

router.delete('/leaderboard/:id', (req, res) => {
  const existing = db.getLeaderboardEntryRow(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Entry not found.' });
  db.deleteLeaderboardEntry(req.params.id);
  res.json({ ok: true });
});

router.post('/leaderboard/:id/reorder', (req, res) => {
  const entry = db.getLeaderboardEntryRow(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });

  const siblings = db.listLeaderboardEntriesForAdmin();
  const index = siblings.findIndex((e) => e.id === entry.id);
  const targetIndex = req.body.direction === 'up' ? index - 1 : index + 1;

  if (targetIndex < 0 || targetIndex >= siblings.length) {
    return res.json({ entries: siblings.map(leaderboardEntryToJson) }); // already at the end, no-op
  }

  db.swapLeaderboardRank(entry.id, siblings[targetIndex].id);
  res.json({ entries: db.listLeaderboardEntriesForAdmin().map(leaderboardEntryToJson) });
});

// Marking a winner clears any previous one (see db.setLeaderboardWinner) —
// only ever one Feature Winner badge live at a time. Posting the same id
// again, or a dedicated "clear" flag, removes the badge entirely.
router.post('/leaderboard/:id/winner', (req, res) => {
  if (req.body.clear) {
    db.clearLeaderboardWinner();
    return res.json({ entries: db.listLeaderboardEntriesForAdmin().map(leaderboardEntryToJson) });
  }
  const entry = db.getLeaderboardEntryRow(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  db.setLeaderboardWinner(req.params.id);
  res.json({ entries: db.listLeaderboardEntriesForAdmin().map(leaderboardEntryToJson) });
});

// Contest-wide round progression (Open Pool / Top 10 / Top 3) for one entry —
// Kyle's manual call at each narrowing step, same pattern as the winner
// endpoint above. Marking the actual Winner (above) is its own step and
// separately advances the contest to the Final round.
router.post('/leaderboard/:id/round', (req, res) => {
  const entry = db.getLeaderboardEntryRow(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  if (!['pool', 'top10', 'top3'].includes(req.body.round)) {
    return res.status(400).json({ error: 'Round must be pool, top10, or top3.' });
  }
  db.setLeaderboardEntryRound(req.params.id, req.body.round);
  res.json({ entries: db.listLeaderboardEntriesForAdmin().map(leaderboardEntryToJson) });
});

// Kyle's top-3-of-that-specific-stream flag — independent of the round
// above. No server-side cap at 3; that's a guideline Kyle self-manages.
router.post('/leaderboard/:id/stream-top-pick', (req, res) => {
  const entry = db.getLeaderboardEntryRow(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  db.setLeaderboardStreamTopPick(req.params.id, !!req.body.value);
  res.json({ entries: db.listLeaderboardEntriesForAdmin().map(leaderboardEntryToJson) });
});

// --- Sales report ---
// One row per completed order. Every kyle-store purchase is for a whole
// project (single/EP/album) at once — there's no way for a fan to buy one
// song out of a multi-track release — so each row here is naturally a
// "whole project" sale. That maps directly onto how Super Duper Splits (or
// any royalty tool) should split revenue: evenly across every track in that
// project, then by each track's contributor percentages.
function csvField(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function csvRow(order) {
  // created_at is stored UTC without a 'Z' suffix by SQLite's datetime('now') —
  // slice to just the date so it lines up with the <input type="date"> fields
  // both this report's filters and Super Duper Splits use.
  const date = (order.fulfilledAt || order.createdAt || '').slice(0, 10);
  return [
    order.orderNumber,
    date,
    order.projectTitle,
    order.projectType,
    1, // quantity — always 1, kyle-store checkout doesn't support buying multiple copies
    order.email,
    (order.amountCents / 100).toFixed(2),
    order.currency,
    order.status,
    order.stripeSessionId, // kept for the rare case you need to look this order up in Stripe's own dashboard
  ];
}

router.get('/sales', (req, res) => {
  const sales = db.listSalesForReport({ from: req.query.from, to: req.query.to });
  res.json({ sales });
});

router.get('/sales/export.csv', (req, res) => {
  const sales = db.listSalesForReport({ from: req.query.from, to: req.query.to });
  const header = ['Order #', 'Date', 'Project', 'Type', 'Quantity', 'Customer Email', 'Amount', 'Currency', 'Status', 'Stripe Session ID'];
  const csv = [header, ...sales.map(csvRow)].map((row) => row.map(csvField).join(',')).join('\r\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="kyle-store-sales-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

router.post('/projects/:id/cover', (req, res) => {
  imageUpload.single('cover')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const project = db.getProjectRow(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    if (!req.file) return res.status(400).json({ error: 'No image received.' });

    const ext = extOf(req.file.originalname) || '.jpg';
    const filename = `${req.params.id}-cover${ext}`;

    if (project.cover_art_file && project.cover_art_file !== filename) {
      safeUnlink(path.join(ART_DIR, project.cover_art_file));
    }

    fs.writeFileSync(path.join(ART_DIR, filename), req.file.buffer);
    db.updateProject(req.params.id, { cover_art_file: filename });

    res.json({ project: catalog.getProject(req.params.id) });
  });
});

// --- Tracks ---

router.post('/projects/:id/tracks', (req, res) => {
  audioUpload.single('audio')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const project = db.getProjectRow(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    if (!req.file) return res.status(400).json({ error: 'No audio file received.' });

    const title = (req.body.title || path.parse(req.file.originalname).name || 'Untitled').trim();
    const released = req.body.released !== 'false'; // default true
    const trackId = slugId(title);
    const ext = extOf(req.file.originalname) || '.mp3';
    const audioFilename = `${trackId}${ext}`;
    const audioPath = path.join(AUDIO_DIR, audioFilename);

    // Always processed on local disk first — ffprobe/ffmpeg need a real
    // filesystem path, S3 or not. storage.persistAudioFile() moves the
    // result off local disk afterward when STORAGE_DRIVER=s3.
    fs.writeFileSync(audioPath, req.file.buffer);

    const durationSeconds = await getDurationSeconds(audioPath);

    let previewFilename = null;
    const previewPath = path.join(AUDIO_DIR, `${trackId}-preview.mp3`);
    const previewResult = await generatePreviewClip(audioPath, previewPath, durationSeconds);
    if (previewResult.ok) {
      previewFilename = `${trackId}-preview.mp3`;
    }

    await storage.persistAudioFile(audioPath, audioFilename);
    if (previewFilename) await storage.persistAudioFile(previewPath, previewFilename);

    db.insertTrack({
      id: trackId,
      projectId: req.params.id,
      trackNumber: db.nextTrackNumber(req.params.id),
      title,
      audioFile: audioFilename,
      previewAudioFile: previewFilename,
      durationSeconds,
      released: released ? 1 : 0,
    });

    res.json({
      project: catalog.getProject(req.params.id),
      previewGenerated: !!previewFilename,
      warning: previewFilename
        ? null
        : "Song uploaded, but an automatic preview clip couldn't be made — fans just won't get a preview player for it. The full song still sells and downloads fine.",
    });
  });
});

router.put('/tracks/:id', (req, res) => {
  const existing = db.getTrackRow(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Track not found.' });

  const title = (req.body.title || existing.title).trim();
  const released = req.body.released === undefined ? !!existing.released : req.body.released === true || req.body.released === 'true';

  db.updateTrack(req.params.id, { title, released: released ? 1 : 0 });
  res.json({ project: catalog.getProject(existing.project_id) });
});

router.delete('/tracks/:id', async (req, res) => {
  const track = db.getTrackRow(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found.' });

  await storage.deleteAudioFile(track.audio_file);
  if (track.preview_audio_file) await storage.deleteAudioFile(track.preview_audio_file);

  const projectId = track.project_id;
  db.deleteTrack(req.params.id);
  res.json({ project: catalog.getProject(projectId) });
});

router.post('/tracks/:id/reorder', (req, res) => {
  const track = db.getTrackRow(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found.' });

  const siblings = db.listTracksForProject(track.project_id);
  const index = siblings.findIndex((t) => t.id === track.id);
  const targetIndex = req.body.direction === 'up' ? index - 1 : index + 1;

  if (targetIndex < 0 || targetIndex >= siblings.length) {
    return res.json({ project: catalog.getProject(track.project_id) }); // already at the end, no-op
  }

  db.swapTrackOrder(track.id, siblings[targetIndex].id);
  res.json({ project: catalog.getProject(track.project_id) });
});

module.exports = router;
