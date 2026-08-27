// Multer config for admin uploads. Uses memory storage (not disk storage)
// because the final filename depends on a database ID that doesn't exist
// until the route handler creates the record — so the handler decides where
// the bytes land, after multer just hands it the buffer.

const multer = require('multer');
const path = require('path');
const fs = require('fs');

const AUDIO_DIR = path.join(__dirname, '..', 'data', 'audio');
const ART_DIR = path.join(__dirname, '..', 'data', 'art');
for (const dir of [AUDIO_DIR, ART_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.wma'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

const MAX_AUDIO_BYTES = 200 * 1024 * 1024; // 200MB — generous for uncompressed masters
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function extOf(filename) {
  return path.extname(filename || '').toLowerCase();
}

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES },
  fileFilter(req, file, cb) {
    if (!AUDIO_EXTENSIONS.includes(extOf(file.originalname))) {
      return cb(new Error(`"${file.originalname}" doesn't look like an audio file. Supported: ${AUDIO_EXTENSIONS.join(', ')}`));
    }
    cb(null, true);
  },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter(req, file, cb) {
    if (!IMAGE_EXTENSIONS.includes(extOf(file.originalname))) {
      return cb(new Error(`"${file.originalname}" doesn't look like an image. Supported: ${IMAGE_EXTENSIONS.join(', ')}`));
    }
    cb(null, true);
  },
});

module.exports = { audioUpload, imageUpload, extOf, AUDIO_DIR, ART_DIR };
