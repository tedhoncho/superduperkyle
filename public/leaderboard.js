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

function renderEntry(entry, opts) {
  const { rankNumber, thumbsEnabled, votedIds, thumbsLimitOne, isFanFavorite, showDateMeta } = opts;
  const winnerBadge = entry.isWinner ? '<span class="winner-badge">🏆 Feature Winner</span>' : '';
  const favoriteBadge = isFanFavorite ? '<span class="favorite-badge">🔥 Fan Favorite</span>' : '';
  const rankLabel = rankNumber ? `<span class="entry-rank">#${rankNumber}</span>` : '';
  const linkHtml = entry.link
    ? `<a href="${entry.link}" class="entry-link" target="_blank" rel="noopener">Listen</a>`
    : '';
  const hasVoted = thumbsLimitOne && votedIds.has(entry.id);
  const thumbsHtml = thumbsEnabled
    ? `<button type="button" class="entry-thumbs${hasVoted ? ' is-voted' : ''}" data-entry-id="${entry.id}" ${hasVoted ? 'disabled' : ''} aria-label="${hasVoted ? 'You gave this a SMYLE face' : 'Give this pick a SMYLE face'}">😊 <span class="entry-thumbs-count">${entry.thumbsCount || 0}</span></button>`
    : '';
  // The date is redundant once entries are grouped under a date heading —
  // only repeat it inline when there's no group heading providing that
  // context (rank mode, which isn't date-ordered).
  const metaHtml = showDateMeta ? `<p class="entry-meta">Picked on stream &middot; ${formatDate(entry.streamDate)}</p>` : '';

  return `
    <div class="leaderboard-entry${entry.isWinner ? ' is-winner' : ''}">
      ${rankLabel}
      <div class="entry-body">
        <h3>${entry.artist} <span class="entry-dash">&mdash;</span> ${entry.songTitle}</h3>
        ${metaHtml}
      </div>
      <div class="entry-actions">
        ${winnerBadge}
        ${favoriteBadge}
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
      btn.setAttribute('aria-label', 'You gave this a SMYLE face');
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

// Big countdown-clock-style stat card under the subheading — same "small
// label, big pink tabular number" treatment as the site's countdown banner.
// The SMYLE face stat only shows up when the feature is actually on — an
// unconditional "0 SMYLE faces" when the button isn't even visible to fans
// would just be confusing. (SMYLE face is Kyle's own name for the thumbs-up
// button, not "thumbs" — keep that wording in anything fans see.)
function renderStats(entries, thumbsEnabled) {
  const totalPicks = entries.length;
  const items = [{ label: totalPicks === 1 ? 'Pick So Far' : 'Picks So Far', value: totalPicks }];
  if (thumbsEnabled) {
    const totalThumbs = entries.reduce((sum, e) => sum + (e.thumbsCount || 0), 0);
    items.push({ label: totalThumbs === 1 ? 'SMYLE Face' : 'SMYLE Faces', value: totalThumbs });
  }
  const itemsHtml = items
    .map(
      (item) => `
        <div class="stats-item">
          <span class="stats-label">${item.label}</span>
          <span class="stats-value">${item.value}</span>
        </div>
      `
    )
    .join('');
  return `<div class="leaderboard-stats">${itemsHtml}</div>`;
}

// Whoever has the most thumbs is the Fan Favorite — separate from (and can
// overlap with) Kyle's own Feature Winner pick. Only meaningful when thumbs
// are on and at least one vote exists; with everyone tied at zero there's
// nothing to actually favor, so nobody gets the badge rather than an
// arbitrary entry looking falsely popular. Ties for the top count all get it.
function computeFanFavoriteIds(entries, thumbsEnabled) {
  if (!thumbsEnabled) return new Set();
  const max = Math.max(0, ...entries.map((e) => e.thumbsCount || 0));
  if (max <= 0) return new Set();
  return new Set(entries.filter((e) => (e.thumbsCount || 0) === max).map((e) => e.id));
}

// A standalone spotlight card above the regular list — the entry still
// appears in its normal spot in the list too (with its badge), this is just
// a bigger, harder-to-miss callout for the one Kyle actually chose.
function renderWinnerHero(entry) {
  const linkHtml = entry.link
    ? `<a href="${entry.link}" class="winner-hero-link" target="_blank" rel="noopener">Listen to the winning song</a>`
    : '';
  return `
    <div class="leaderboard-winner-hero">
      <div class="winner-hero-trophy" aria-hidden="true">🏆</div>
      <p class="winner-hero-label">Feature Winner</p>
      <h2 class="winner-hero-title">${entry.artist} <span class="entry-dash">&mdash;</span> ${entry.songTitle}</h2>
      <p class="winner-hero-meta">Picked on stream &middot; ${formatDate(entry.streamDate)}</p>
      ${linkHtml}
    </div>
  `;
}

// Entries already arrive sorted (stream_date DESC from the server in date
// mode), so grouping is just noticing where the date changes as we walk the
// list — no re-sorting needed.
function groupByStreamDate(entries) {
  const groups = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.streamDate === entry.streamDate) {
      last.entries.push(entry);
    } else {
      groups.push({ streamDate: entry.streamDate, entries: [entry] });
    }
  }
  return groups;
}

function renderEntries(sortMode, entries, heading, subheading, thumbsEnabled, thumbsLimitOne) {
  const headingHtml = `<h1>${escapeHtml(heading)}</h1>${subheading ? `<p class="leaderboard-sub">${escapeHtml(subheading)}</p>` : ''}`;

  if (!entries.length) {
    mainEl.innerHTML = `${headingHtml}<p class="loading">No picks yet — check back after the next stream.</p>`;
    return;
  }

  const votedIds = thumbsEnabled && thumbsLimitOne ? getVotedEntryIds() : new Set();
  const favoriteIds = computeFanFavoriteIds(entries, thumbsEnabled);
  const statsHtml = renderStats(entries, thumbsEnabled);
  const winnerEntry = entries.find((e) => e.isWinner) || null;
  const winnerHeroHtml = winnerEntry ? renderWinnerHero(winnerEntry) : '';

  const entryOpts = (e, rankNumber, showDateMeta) => ({
    rankNumber,
    thumbsEnabled,
    votedIds,
    thumbsLimitOne,
    isFanFavorite: favoriteIds.has(e.id),
    showDateMeta,
  });

  let listHtml;
  if (sortMode === 'rank') {
    // Rank order isn't date-coherent (that's the whole point of rank mode),
    // so grouping by date wouldn't make sense here — keep the flat numbered
    // list, same as before.
    const rows = entries.map((e, i) => renderEntry(e, entryOpts(e, i + 1, true))).join('');
    listHtml = `<div class="leaderboard-list">${rows}</div>`;
  } else {
    const groups = groupByStreamDate(entries);
    listHtml = groups
      .map(
        (group) => `
          <div class="leaderboard-date-group">
            <h2 class="leaderboard-date-heading">${formatDate(group.streamDate)}</h2>
            <div class="leaderboard-list">
              ${group.entries.map((e) => renderEntry(e, entryOpts(e, null, false))).join('')}
            </div>
          </div>
        `
      )
      .join('');
  }

  mainEl.innerHTML = `${headingHtml}${statsHtml}${winnerHeroHtml}${listHtml}`;
  maybeLaunchConfetti(winnerEntry);
}

// --- Winner confetti ---
// A one-time celebration, not a repeating page decoration: remembers (per
// browser) the id of the last winner it already celebrated, so refreshing
// the page or coming back later to check the same winner doesn't replay it
// every time — but a genuinely new winner being announced gets its own
// fresh burst. Skips entirely for anyone who's asked their OS/browser for
// reduced motion.
const CONFETTI_SEEN_KEY = 'sdk_leaderboard_confetti_seen_winner';

function maybeLaunchConfetti(winnerEntry) {
  if (!winnerEntry) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let alreadySeen = false;
  try {
    alreadySeen = localStorage.getItem(CONFETTI_SEEN_KEY) === winnerEntry.id;
  } catch (err) {
    // Can't check — fine to just play it rather than block on it.
  }
  if (alreadySeen) return;

  try {
    localStorage.setItem(CONFETTI_SEEN_KEY, winnerEntry.id);
  } catch (err) {
    // Not remembered this time, but the celebration itself doesn't depend on it.
  }
  launchConfetti();
}

function launchConfetti() {
  const canvas = document.createElement('canvas');
  canvas.className = 'leaderboard-confetti';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return;
  }

  const colors = ['#eb66ae', '#ffd166', '#06d6a0', '#4cc9f0'];
  const particles = Array.from({ length: 130 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.4,
    size: 5 + Math.random() * 5,
    color: colors[Math.floor(Math.random() * colors.length)],
    speedY: 2 + Math.random() * 3,
    speedX: -1.5 + Math.random() * 3,
    rotation: Math.random() * 360,
    spin: -6 + Math.random() * 12,
  }));

  const durationMs = 3000;
  const start = performance.now();

  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.x += p.speedX;
      p.y += p.speedY;
      p.rotation += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (elapsed < durationMs) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  }
  requestAnimationFrame(frame);
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
