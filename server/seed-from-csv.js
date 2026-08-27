// One-time helper: imports the sample catalog from the old data/*.csv files
// into the database, so the demo data still exists after switching the
// catalog from CSV-editing to the admin UI. Only runs if the projects table
// is currently empty — safe to leave in place, it won't clobber anything
// Kyle has already added through the admin UI.
//
// Run manually with: node server/seed-from-csv.js

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const db = require('./db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROJECTS_CSV = path.join(DATA_DIR, 'projects.csv');
const TRACKS_CSV = path.join(DATA_DIR, 'tracks.csv');

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true, trim: true });
}

function seed() {
  const existing = db.listProjects();
  if (existing.length > 0) {
    console.log(`Skipping seed — ${existing.length} project(s) already in the database.`);
    return;
  }
  if (!fs.existsSync(PROJECTS_CSV) || !fs.existsSync(TRACKS_CSV)) {
    console.log('No sample CSVs found — nothing to seed.');
    return;
  }

  const projectRows = readCsv(PROJECTS_CSV);
  const trackRows = readCsv(TRACKS_CSV);

  for (const row of projectRows) {
    db.insertProject({
      id: row.project_id,
      title: row.title,
      type: row.type || 'single',
      releaseYear: row.release_year || null,
      coverArtFile: row.cover_art_file || null,
      pricingMode: (row.pricing_mode || '').trim().toLowerCase(),
      fixedPriceCents: row.fixed_price_cents ? parseInt(row.fixed_price_cents, 10) : null,
      pwywMinPerTrackCents: row.pwyw_min_per_track_cents ? parseInt(row.pwyw_min_per_track_cents, 10) : null,
      suggestedAmountsCents: row.suggested_amounts_cents || '',
      description: row.description || '',
    });
  }

  for (const row of trackRows) {
    db.insertTrack({
      id: row.track_id,
      projectId: row.project_id,
      trackNumber: parseInt(row.track_number, 10) || 1,
      title: row.title,
      audioFile: row.audio_file,
      previewAudioFile: row.preview_audio_file || null,
      durationSeconds: parseInt(row.duration_seconds, 10) || 0,
      released: (row.released || '').trim().toLowerCase() === 'yes' ? 1 : 0,
    });
  }

  console.log(`Seeded ${projectRows.length} project(s) and ${trackRows.length} track(s) from CSV.`);
}

if (require.main === module) {
  seed();
}

module.exports = { seed };
