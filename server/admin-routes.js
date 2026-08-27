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
