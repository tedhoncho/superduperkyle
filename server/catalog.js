// Reads the catalog straight from SQLite on every call — no in-memory cache,
// no restart needed. When Kyle adds a song through the admin UI, it's a
// database write, and the very next storefront page load sees it.
//
// (Earlier version of this file read data/*.csv instead. That's gone now —
// the admin UI is the only way to edit the catalog. See server/db.js for
// the underlying tables and server/admin-routes.js for the write side.)

const db = require('./db');

function toIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

function rowToProject(row) {
  const tracks = db.listTracksForProject(row.id).map((t) => ({
    id: t.id,
    projectId: t.project_id,
    trackNumber: t.track_number,
    title: t.title,
    audioFile: t.audio_file,
    previewAudioFile: t.preview_audio_file,
    durationSeconds: t.duration_seconds,
    released: !!t.released,
  }));

  return {
    id: row.id,
    title: row.title,
    type: row.type,
    releaseYear: row.release_year,
    coverArtFile: row.cover_art_file,
    pricingMode: row.pricing_mode,
    fixedPriceCents: row.fixed_price_cents,
    pwywMinPerTrackCents: row.pwyw_min_per_track_cents,
    suggestedAmountsCents: (row.suggested_amounts_cents || '')
      .split('|')
      .map((s) => toIntOrNull(s))
      .filter((n) => n !== null),
    description: row.description || '',
    soldOut: !!row.sold_out,
    comingSoon: !!row.coming_soon,
    releaseMode: row.release_mode || 'manual',
    tracks,
  };
}

function getProject(projectId) {
  const row = db.getProjectRow(projectId);
  if (!row) return null;
  return rowToProject(row);
}

function getTrack(projectId, trackId) {
  const project = getProject(projectId);
  if (!project) return null;
  return project.tracks.find((t) => t.id === trackId) || null;
}

// All projects, including ones with zero released tracks (those are simply
// hidden from the public storefront — see listProjectsPublic — but the
// admin dashboard needs to see everything).
function listAllProjects() {
  return db.listProjects().map(rowToProject);
}

function listProjectsPublic() {
  return listAllProjects()
    // Hide empty/all-unreleased projects from fans -- UNLESS Ted has
    // explicitly marked one "coming soon", in which case it's meant to be
    // seen (browsable, not-yet-buyable) ahead of its actual release.
    .filter((p) => p.tracks.some((t) => t.released) || p.comingSoon)
    .map((p) => ({
      id: p.id,
      title: p.title,
      type: p.type,
      releaseYear: p.releaseYear,
      coverArtFile: p.coverArtFile,
      pricingMode: p.pricingMode,
      fixedPriceCents: p.fixedPriceCents,
      pwywMinPerTrackCents: p.pwywMinPerTrackCents,
      suggestedAmountsCents: p.suggestedAmountsCents,
      description: p.description,
      soldOut: p.soldOut,
      comingSoon: p.comingSoon,
      tracks: p.tracks.map((t) => ({
        id: t.id,
        trackNumber: t.trackNumber,
        title: t.title,
        previewAudioFile: t.previewAudioFile,
        durationSeconds: t.durationSeconds,
        released: t.released,
      })),
    }));
}

// Compute the price for a project purchase.
// - fixed: always fixedPriceCents, ignore requestedAmountCents.
// - pwyw: minimum = pwywMinPerTrackCents * (# released tracks), requestedAmountCents must be >= minimum.
function priceForProject(project, requestedAmountCents) {
  const releasedCount = project.tracks.filter((t) => t.released).length;

  if (project.pricingMode === 'fixed') {
    return { amountCents: project.fixedPriceCents, minCents: project.fixedPriceCents, releasedCount };
  }

  const minCents = project.pwywMinPerTrackCents * releasedCount;
  const amountCents = Math.max(toIntOrNull(requestedAmountCents) || 0, minCents);
  return { amountCents, minCents, releasedCount };
}

module.exports = {
  getProject,
  getTrack,
  listAllProjects,
  listProjectsPublic,
  priceForProject,
};
