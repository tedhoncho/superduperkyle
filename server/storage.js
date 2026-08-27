// Storage abstraction for the actual (purchasable + preview) audio files.
//
// STORAGE_DRIVER=local (default): files live on this server's disk under
// data/audio/. Fine for testing, and fine for a small catalog — but most
// hosting platforms (Railway, Render, Vercel, etc.) give you EPHEMERAL disk,
// meaning a redeploy can wipe data/audio/. Once Kyle is uploading real
// masters through the admin dashboard (not committed to git, so there's no
// other copy), that's a real risk, not a theoretical one.
//
// STORAGE_DRIVER=s3: audio files are uploaded to an S3 bucket (or
// S3-compatible: Cloudflare R2, Backblaze B2) right after the admin upload
// finishes processing them, and the local copies used for ffprobe/ffmpeg are
// deleted afterward. Downloads are served via short-lived signed URLs
// instead of streaming through this server.
//
// SCOPE NOTE: this covers audio only. Cover art still always lives on local
// disk (data/art/, served by a plain express.static route) — losing a cover
// image on a redeploy is a quick re-upload, not a lost master, so it wasn't
// worth the same treatment. Revisit if that stops being true.

const fs = require('fs');
const path = require('path');

const DRIVER = process.env.STORAGE_DRIVER || 'local';
const AUDIO_DIR = path.join(__dirname, '..', 'data', 'audio');

function s3Client() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
}

async function getDownloadForFile(filename) {
  if (DRIVER === 'local') {
    const filePath = path.join(AUDIO_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return { ok: false, reason: `File not found on disk: ${filename}` };
    }
    return { ok: true, type: 'stream', filePath };
  }

  if (DRIVER === 's3') {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

    const command = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: filename });
    const url = await getSignedUrl(s3Client(), command, { expiresIn: 300 }); // 5 min signed URL
    return { ok: true, type: 'redirect', url };
  }

  return { ok: false, reason: `Unknown STORAGE_DRIVER "${DRIVER}"` };
}

// Called right after the admin upload has finished writing `localPath` and
// (for audio) running ffprobe/ffmpeg against it. In local mode this is a
// no-op — the file's already where it needs to be. In s3 mode it uploads the
// file under `filename` as the S3 key and removes the local copy, so local
// disk never ends up as the only copy of something Kyle just uploaded.
async function persistAudioFile(localPath, filename) {
  if (DRIVER === 'local') return { ok: true };

  if (DRIVER === 's3') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    try {
      const body = fs.readFileSync(localPath);
      await s3Client().send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: filename, Body: body }));
      fs.unlinkSync(localPath);
      return { ok: true };
    } catch (err) {
      console.error('[storage] S3 upload failed, leaving local copy in place:', err.message);
      return { ok: false, reason: err.message };
    }
  }

  return { ok: false, reason: `Unknown STORAGE_DRIVER "${DRIVER}"` };
}

// Mirror of persistAudioFile for cleanup — called when a track/project is
// deleted, or a file is replaced, so S3 doesn't accumulate orphaned objects
// that Kyle can no longer see (and would still be paying storage cost for).
async function deleteAudioFile(filename) {
  if (DRIVER === 'local') {
    const filePath = path.join(AUDIO_DIR, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }

  if (DRIVER === 's3') {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    try {
      await s3Client().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: filename }));
    } catch (err) {
      console.error('[storage] S3 delete failed for', filename, ':', err.message);
    }
  }
}

module.exports = { getDownloadForFile, persistAudioFile, deleteAudioFile, AUDIO_DIR, DRIVER };
