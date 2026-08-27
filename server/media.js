// Audio processing so Kyle never has to prepare anything himself: given the
// full-quality file he drops in, this detects its length and cuts a short
// preview clip automatically. Requires ffmpeg/ffprobe on the server (both
// are standard apt/brew packages — Railway and Render's Node buildpacks do
// NOT include them by default, see README for the one-line fix).

const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

const PREVIEW_SECONDS = parseInt(process.env.PREVIEW_CLIP_SECONDS || '25', 10);

async function getDurationSeconds(filePath) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath,
    ]);
    const data = JSON.parse(stdout);
    const seconds = parseFloat(data.format?.duration);
    return Number.isFinite(seconds) ? Math.round(seconds) : 0;
  } catch (err) {
    console.error('[media] ffprobe failed:', err.message);
    return 0;
  }
}

// Cuts the first PREVIEW_SECONDS of `sourcePath` (or the whole thing if
// shorter) into `outputPath`, with a short fade-out so it doesn't cut off
// mid-note. Always outputs mp3 for broad browser support regardless of the
// source format (wav/flac/m4a masters all work as input).
async function generatePreviewClip(sourcePath, outputPath, durationSeconds) {
  const clipLength = Math.min(PREVIEW_SECONDS, durationSeconds || PREVIEW_SECONDS);
  const fadeStart = Math.max(clipLength - 2, 0);

  try {
    await execFileP('ffmpeg', [
      '-y',
      '-i', sourcePath,
      '-t', String(clipLength),
      '-af', `afade=t=out:st=${fadeStart}:d=2`,
      '-codec:a', 'libmp3lame',
      '-qscale:a', '4',
      outputPath,
    ]);
    return { ok: true };
  } catch (err) {
    console.error('[media] ffmpeg preview generation failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = { getDurationSeconds, generatePreviewClip, PREVIEW_SECONDS };
