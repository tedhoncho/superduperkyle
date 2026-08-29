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

// --- Fan thumbs-up ---
// Future-proofing feature (off by default — see settings.leaderboardThumbsEnabled).
// Whether repeat voting is allowed is Ted's own call (settings.leaderboardThumbsLimitOne):
// he plans to launch with it OFF — unlimited votes from the same browser, to
// build buzz while the site is new and low-traffic — then turn it on later
// once traffic is high enough that ballot-stuffing actually matters. When
// it's on, "one vote per fan" is enforced the only way available without a
// login system: remembering which entries this browser has already
// thumbsed, in localStorage. Not fraud-proof (a different browser, or
// clearing site data, resets it) — an accepted tradeoff either way for a
// fun engagement number, not something anything else on the site depends on.
const THUMBS_VOTED_KEY = 'sdk_leaderboard_thumbs_voted';

// Set once per load() from settings.leaderboardThumbsLimitOne — read by the
// delegated click handler below, which doesn't otherwise know which mode
// the currently-rendered entries were built under.
let thumbsLimitOneMode = false;

function getVotedEntryIds() {
  try {
    const raw = localStorage.getItem(THUMBS_VOTED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (err) {
    return new Set(); // private-mode/blocked storage — voting still works, just isn't remembered
  }
}

function markEntryVoted(id) {
  try {
    const voted = getVotedEntryIds();
    voted.add(id);
    localStorage.setItem(THUMBS_VOTED_KEY, JSON.stringify([...voted]));
  } catch (err) {
    // Nothing to do — this vote still counted server-side, it just won't be
    // remembered as "already voted" on a reload.
  }
}

function renderEntry(entry, rankNumber, thumbsEnabled, votedIds, thumbsLimitOne) {
  const winnerBadge = entry.isWinner ? '<span class="winner-badge">🏆 Feature Winner</span>' : '';
  const rankLabel = rankNumber ? `<span class="entry-rank">#${rankNumber}</span>` : '';
  const linkHtml = entry.link
    ? `<a href="${entry.link}" class="entry-link" target="_blank" rel="noopener">Listen</a>`
    : '';
  const hasVoted = thumbsLimitOne && votedIds.has(entry.id);
  const thumbsHtml = thumbsEnabled
    ? `<button type="button" class="entry-thumbs${hasVoted ? ' is-voted' : ''}" data-entry-id="${entry.id}" ${hasVoted ? 'disabled' : ''} aria-label="${hasVoted ? 'You thumbed this up' : 'Thumbs up this pick'}">😊 <span class="entry-thumbs-count">${entry.thumbsCount || 0}</span></button>`
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
        ${thumbsHtml}
        ${linkHtml}
      </div>
    </div>
  `;
}

// Delegated once on the static container rather than re-bound on every
// render — mainEl's innerHTML gets replaced wholesale each load(), but
// mainEl itself never does.
mainEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.entry-thumbs');
  if (!btn || btn.disabled) return;
  const entryId = btn.dataset.entryId;
  // Disabled during the request either way, so a fast double-click can't
  // fire two requests — in unlimited mode this is just a brief debounce,
  // not a permanent lock.
  btn.disabled = true;
  try {
    const res = await fetch(`/api/leaderboard/${entryId}/thumbs`, { method: 'POST' });
    if (!res.ok) throw new Error('vote request failed');
    const data = await res.json();
    btn.querySelector('.entry-thumbs-count').textContent = data.thumbsCount;
    if (thumbsLimitOneMode) {
      btn.classList.add('is-voted');
      btn.setAttribute('aria-label', 'You thumbed this up');
      markEntryVoted(entryId);
      // Stays disabled — one vote per browser is the whole point of this mode.
    } else {
      btn.disabled = false; // unlimited voting — ready for the next click right away
    }
  } catch (err) {
    // Network hiccup or the contest closed mid-click — let them try again
    // rather than leaving the button permanently stuck.
    btn.disabled = false;
  }
});

// Escapes the admin-editable heading/subheading text before dropping it
// into innerHTML, since it's free-form input from a form rather than a
// fixed template string.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderEntries(sortMode, entries, heading, subheading, thumbsEnabled, thumbsLimitOne) {
  const headingHtml = `<h1>${escapeHtml(heading)}</h1>${subheading ? `<p class="leaderboard-sub">${escapeHtml(subheading)}</p>` : ''}`;

  if (!entries.length) {
    mainEl.innerHTML = `${headingHtml}<p class="loading">No picks yet — check back after the next stream.</p>`;
    return;
  }

  const votedIds = thumbsEnabled && thumbsLimitOne ? getVotedEntryIds() : new Set();
  const rows = entries
    .map((e, i) => renderEntry(e, sortMode === 'rank' ? i + 1 : null, thumbsEnabled, votedIds, thumbsLimitOne))
    .join('');
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
    thumbsLimitOneMode = !!data.thumbsLimitOne;

    if (data.visible) {
      renderEntries(data.sortMode, data.entries, data.heading, data.subheading, data.thumbsEnabled, data.thumbsLimitOne);
    } else {
      renderClosed();
    }

    if (data.spotifyPlaylistId) renderSpotifyFooter(data.spotifyPlaylistId);
  } catch (err) {
    mainEl.innerHTML = '<p class="loading">Could not load the leaderboard right now.</p>';
  }
}

load();
