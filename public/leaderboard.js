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

function renderEntries(sortMode, entries) {
  const heading =
    sortMode === 'rank'
      ? '<h1>Feature Contest Ranking</h1><p class="leaderboard-sub">Kyle\'s picks, ranked.</p>'
      : '<h1>Feature Contest Leaderboard</h1><p class="leaderboard-sub">Every stream, Kyle picks his favorite submissions — these are added to the pool for the end-of-month feature.</p>';

  if (!entries.length) {
    mainEl.innerHTML = `${heading}<p class="loading">No picks yet — check back after the next stream.</p>`;
    return;
  }

  const rows = entries.map((e, i) => renderEntry(e, sortMode === 'rank' ? i + 1 : null)).join('');
  mainEl.innerHTML = `${heading}<div class="leaderboard-list">${rows}</div>`;
}

async function load() {
  try {
    const res = await fetch('/api/leaderboard');
    if (res.status === 404) {
      renderClosed();
      return;
    }
    const data = await res.json();
    renderEntries(data.sortMode, data.entries);
  } catch (err) {
    mainEl.innerHTML = '<p class="loading">Could not load the leaderboard right now.</p>';
  }
}

load();
