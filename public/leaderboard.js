const mainEl = document.getElementById('leaderboard-main');

function formatDate(isoDate) {
  // stream_date is stored as a plain 'YYYY-MM-DD' string — parsing with an
  // explicit UTC anchor avoids the classic "shows a day early/late" bug
  // browsers have with bare date strings in local time zones.
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function renderClosed() {
  mainEl.innerHTML = `
    <div class="leaderboard-closed">
      <h2>Nothing to see here right now</h2>
      <p>Check back soon, or follow along on stream for what's next.</p>
    </div>
  `;
}

function renderEntry(entry, rankNumber) {
  const winnerBadge = entry.isWinner ? '<span class="winner-badge">🏆 Feature Winner</span>' : '';
  const rankLabel = rankNumber ? `<span class="entry-rank">#${rankNumber}</span>` : '';
  const linkHtml = entry.link
    ? `<a href="${entry.link}" class="entry-link" target="_blank" rel="noopener">Listen</a>`
    : '';

  return `
    <div class="leaderboard-entry${entry.isWinner ? ' is-winner' : ''}">
      ${rankLabel}
      <div class="entry-body">
        <h3>${entry.artist} <span class="entry-dash">&mdash;</span> ${entry.songTitle}</h3>
        <p class="entry-meta">Picked on stream &middot; ${formatDate(entry.streamDate)}</p>
      </div>
      <div class="entry-actions">
        ${winnerBadge}
        ${linkHtml}
      </div>
    </div>
  `;
}

// Escapes the admin-editable heading/subheading text before dropping it
// into innerHTML, since it's free-form input from a form rather than a
// fixed template string.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderEntries(sortMode, entries, heading, subheading) {
  const headingHtml = `<h1>${escapeHtml(heading)}</h1>${subheading ? `<p class="leaderboard-sub">${escapeHtml(subheading)}</p>` : ''}`;

  if (!entries.length) {
    mainEl.innerHTML = `${headingHtml}<p class="loading">No picks yet — check back after the next stream.</p>`;
    return;
  }

  const rows = entries.map((e, i) => renderEntry(e, sortMode === 'rank' ? i + 1 : null)).join('');
  mainEl.innerHTML = `${headingHtml}<div class="leaderboard-list">${rows}</div>`;
}

// --- Spotify playlist footer ---
// Pinned to the bottom of this page only (not site-wide) and shown whenever
// Ted has a playlist configured, independent of whether the contest entries
// above are currently visible — the playlist is Kyle's ongoing "songs I
// liked" list, not something tied to any one month's contest.
//
// Built once, then just toggled with a class — re-rendering the iframe's
// innerHTML on every collapse/expand would reload it each time, killing any
// playback that was already going. The collapse is session-only by design:
// it always starts expanded on a fresh visit, it just doesn't fight a fan
// who tucks it away while they browse this load.
const footerEl = document.getElementById('spotify-footer');

function setFooterPadding() {
  document.body.style.paddingBottom = footerEl.classList.contains('hidden') ? '' : `${footerEl.offsetHeight}px`;
}

// Compact shows just the now-playing bar; full is tall enough for Spotify's
// embed to switch to its own scrollable track list — same iframe, no reload,
// so playback that's already going doesn't get interrupted.
const SPOTIFY_COMPACT_HEIGHT = 80;
const SPOTIFY_FULL_HEIGHT = 352;

function renderSpotifyFooter(playlistId) {
  footerEl.classList.remove('hidden');
  footerEl.innerHTML = `
    <button id="spotify-footer-expand" class="spotify-footer-icon-btn" aria-label="Show full playlist">+</button>
    <button id="spotify-footer-toggle" class="spotify-footer-icon-btn" aria-label="Hide player">&darr;</button>
    <div class="spotify-footer-player">
      <iframe
        id="spotify-footer-iframe"
        title="Kyle's Spotify playlist"
        src="https://open.spotify.com/embed/playlist/${playlistId}?utm_source=generator"
        width="100%"
        height="${SPOTIFY_COMPACT_HEIGHT}"
        frameborder="0"
        allowfullscreen=""
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        loading="lazy"
      ></iframe>
    </div>
    <button id="spotify-footer-pill" class="spotify-footer-pill hidden">🎧 Kyle's Playlist &uarr;</button>
  `;

  const expandBtn = document.getElementById('spotify-footer-expand');
  const toggleBtn = document.getElementById('spotify-footer-toggle');
  const pillBtn = document.getElementById('spotify-footer-pill');
  const player = footerEl.querySelector('.spotify-footer-player');
  const iframe = document.getElementById('spotify-footer-iframe');

  let trackListShown = false;
  function toggleTrackList() {
    trackListShown = !trackListShown;
    iframe.height = trackListShown ? SPOTIFY_FULL_HEIGHT : SPOTIFY_COMPACT_HEIGHT;
    expandBtn.textContent = trackListShown ? '−' : '+';
    expandBtn.setAttribute('aria-label', trackListShown ? 'Show less' : 'Show full playlist');
    setFooterPadding();
  }
  expandBtn.addEventListener('click', toggleTrackList);

  function collapse() {
    player.classList.add('hidden');
    expandBtn.classList.add('hidden');
    toggleBtn.classList.add('hidden');
    pillBtn.classList.remove('hidden');
    setFooterPadding();
  }
  function expand() {
    player.classList.remove('hidden');
    expandBtn.classList.remove('hidden');
    toggleBtn.classList.remove('hidden');
    pillBtn.classList.add('hidden');
    setFooterPadding();
  }
  toggleBtn.addEventListener('click', collapse);
  pillBtn.addEventListener('click', expand);

  setFooterPadding();
}

async function load() {
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();

    if (data.visible) {
      renderEntries(data.sortMode, data.entries, data.heading, data.subheading);
    } else {
      renderClosed();
    }

    if (data.spotifyPlaylistId) renderSpotifyFooter(data.spotifyPlaylistId);
  } catch (err) {
    mainEl.innerHTML = '<p class="loading">Could not load the leaderboard right now.</p>';
  }
}

load();
