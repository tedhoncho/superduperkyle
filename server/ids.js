const { v4: uuidv4 } = require('uuid');

// Human-readable-ish IDs (used as filenames on disk too), e.g. "night-shift-a1b2c3".
// Falls back to a plain random ID if the title is empty/all-punctuation.
function slugId(title) {
  const slug = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = uuidv4().slice(0, 6);
  return slug ? `${slug}-${suffix}` : uuidv4();
}

module.exports = { slugId };
