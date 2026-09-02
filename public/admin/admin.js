// ---------- tiny helpers ----------

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin' };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function titleFromFilename(filename) {
  return filename.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

function showView(name) {
  document.getElementById('view-login').classList.toggle('hidden', name !== 'login');
  document.getElementById('view-dashboard').classList.toggle('hidden', name !== 'dashboard');
  document.getElementById('view-editor').classList.toggle('hidden', name !== 'editor');
  document.getElementById('view-sales').classList.toggle('hidden', name !== 'sales');
  document.getElementById('view-notifications').classList.toggle('hidden', name !== 'notifications');
  document.getElementById('view-site').classList.toggle('hidden', name !== 'site');
  document.getElementById('view-leaderboard').classList.toggle('hidden', name !== 'leaderboard');
}

// ---------- state ----------

let currentProjectId = null; // null while creating a brand-new project
let pendingCoverFile = null; // held until a new project actually gets created
let pendingTrackFile = null;

// ---------- boot ----------

async function boot() {
  try {
    const { authenticated } = await api('GET', '/api/admin/session');
    if (authenticated) {
      showView('dashboard');
      loadProjects();
    } else {
      showView('login');
    }
  } catch {
    showView('login');
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('login-error');
  errorEl.classList.add('hidden');
  try {
    await api('POST', '/api/admin/login', { password: document.getElementById('login-password').value });
    showView('dashboard');
    loadProjects();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await api('POST', '/api/admin/logout');
  showView('login');
});

// ---------- dashboard ----------

async function loadProjects() {
  const listEl = document.getElementById('project-list');
  listEl.innerHTML = '<p class="admin-loading">Loading…</p>';
  const { projects } = await api('GET', '/api/admin/projects');
  renderProjectList(projects);
}

function renderProjectList(projects) {
  const listEl = document.getElementById('project-list');

  if (!projects.length) {
    listEl.innerHTML = '<p class="admin-empty">Nothing uploaded yet — hit "New Song or Album" to add your first one.</p>';
    return;
  }

  listEl.innerHTML = '';
  projects.forEach((project, index) => {
    const releasedCount = project.tracks.filter((t) => t.released).length;
    const priceLabel =
      project.pricingMode === 'fixed'
        ? (project.fixedPriceCents ? money(project.fixedPriceCents) : 'no price set')
        : `Pay what you want, min ${money((project.pwywMinPerTrackCents || 0) * releasedCount)}`;

    const row = document.createElement('div');
    row.className = 'admin-project-row';
    row.innerHTML = `
      <div class="admin-track-order" title="Reorder — the top release is featured on the storefront">
        <button class="btn-up" ${index === 0 ? 'disabled' : ''}>&and;</button>
        <button class="btn-down" ${index === projects.length - 1 ? 'disabled' : ''}>&or;</button>
      </div>
      ${project.coverArtFile ? `<img class="admin-project-thumb" src="/art/${project.coverArtFile}" />` : '<div class="admin-project-thumb"></div>'}
      <div class="admin-project-info">
        <h3>${project.title}${index === 0 ? ' <span class="admin-featured-badge">Featured</span>' : ''}${project.soldOut ? ' <span class="admin-soldout-badge">Sold Out</span>' : ''}${project.comingSoon ? ` <span class="admin-comingsoon-badge">Coming Soon${project.releaseMode === 'auto' ? ' · Auto' : ''}</span>` : ''}</h3>
        <p>${project.tracks.length} song${project.tracks.length === 1 ? '' : 's'} (${releasedCount} live) · ${priceLabel}</p>
      </div>
      <div class="admin-project-row-actions">
        ${project.comingSoon ? '<button class="admin-btn-ghost btn-go-live">🚀 Go Live</button>' : ''}
        <button class="admin-btn-ghost btn-edit">Edit</button>
        <button class="admin-btn-ghost btn-delete">Delete</button>
      </div>
    `;
    row.querySelector('.btn-up').addEventListener('click', () => reorderProject(project.id, 'up'));
    row.querySelector('.btn-down').addEventListener('click', () => reorderProject(project.id, 'down'));
    row.querySelector('.btn-edit').addEventListener('click', () => openEditor(project));
    row.querySelector('.btn-delete').addEventListener('click', () => deleteProject(project));
    if (project.comingSoon) row.querySelector('.btn-go-live').addEventListener('click', () => goLiveProject(project));
    listEl.appendChild(row);
  });
}

async function reorderProject(projectId, direction) {
  const { projects } = await api('POST', `/api/admin/projects/${projectId}/reorder`, { direction });
  renderProjectList(projects);
}

// One-click release: flips comingSoon off and leaves every other field
// exactly as it already was. PUT /projects/:id re-derives the full field
// set from the body (same route the editor's Save button uses), so this
// resubmits the project's current values rather than sending a partial
// patch. This is the "hit Go Live" moment Ted described -- typically
// clicked the instant a countdown on the storefront reaches zero.
async function goLiveProject(project) {
  if (!confirm(`Make "${project.title}" available to buy right now? This can't be undone from here.`)) return;
  await api('PUT', `/api/admin/projects/${project.id}`, {
    title: project.title,
    type: project.type,
    releaseYear: project.releaseYear || '',
    pricingMode: project.pricingMode,
    price: project.pricingMode === 'fixed'
      ? (project.fixedPriceCents || 0) / 100
      : (project.pwywMinPerTrackCents || 0) / 100,
    description: project.description || '',
    soldOut: project.soldOut,
    comingSoon: false,
  });
  loadProjects();
}

async function deleteProject(project) {
  if (!confirm(`Delete "${project.title}" and all its songs? This can't be undone.`)) return;
  await api('DELETE', `/api/admin/projects/${project.id}`);
  loadProjects();
}

document.getElementById('btn-new-project').addEventListener('click', () => openEditor(null));
document.getElementById('btn-back').addEventListener('click', () => {
  showView('dashboard');
  loadProjects();
});

// ---------- sales report ----------

function salesQueryString() {
  const from = document.getElementById('sales-from').value;
  const to = document.getElementById('sales-to').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function loadSales() {
  const wrap = document.getElementById('sales-table-wrap');
  wrap.innerHTML = '<p class="admin-loading">Loading…</p>';
  document.getElementById('btn-export-sales').href = `/api/admin/sales/export.csv${salesQueryString()}`;

  const { sales } = await api('GET', `/api/admin/sales${salesQueryString()}`);
  renderSales(sales);
}

function renderSales(sales) {
  const totalRevenueCents = sales.reduce((sum, s) => sum + s.amountCents, 0);
  document.getElementById('sales-summary').innerHTML = `
    <div class="admin-sales-metric"><span>${sales.length}</span>Sale${sales.length === 1 ? '' : 's'}</div>
    <div class="admin-sales-metric"><span>${money(totalRevenueCents)}</span>Total revenue</div>
  `;

  const wrap = document.getElementById('sales-table-wrap');
  if (!sales.length) {
    wrap.innerHTML = '<p class="admin-empty">No sales in this range yet.</p>';
    return;
  }

  wrap.innerHTML = `
    <table class="admin-sales-table">
      <thead>
        <tr><th>Order #</th><th>Date</th><th>Project</th><th>Type</th><th>Customer</th><th>Amount</th><th>Status</th></tr>
      </thead>
      <tbody>
        ${sales
          .map((s) => {
            const date = (s.fulfilledAt || s.createdAt || '').slice(0, 10);
            return `
              <tr>
                <td>${s.orderNumber || '—'}</td>
                <td>${date}</td>
                <td>${s.projectTitle}</td>
                <td>${s.projectType}</td>
                <td>${s.email}</td>
                <td>${money(s.amountCents)}</td>
                <td>${s.status}</td>
              </tr>
            `;
          })
          .join('')}
      </tbody>
    </table>
  `;
}

document.getElementById('btn-view-sales').addEventListener('click', () => {
  showView('sales');
  loadSales();
});
document.getElementById('btn-sales-back').addEventListener('click', () => showView('dashboard'));
document.getElementById('btn-sales-filter').addEventListener('click', loadSales);
document.getElementById('btn-sales-clear').addEventListener('click', () => {
  document.getElementById('sales-from').value = '';
  document.getElementById('sales-to').value = '';
  loadSales();
});

// ---------- notifications ----------

async function loadNotificationSettings() {
  document.getElementById('notifications-error').classList.add('hidden');
  document.getElementById('notifications-success').classList.add('hidden');
  const { settings } = await api('GET', '/api/admin/settings');
  document.getElementById('field-notification-emails').value = settings.saleNotificationEmails || '';
  document.getElementById('field-confirmation-message').value = settings.confirmationMessage || '';
}

document.getElementById('btn-view-notifications').addEventListener('click', () => {
  showView('notifications');
  loadNotificationSettings();
});
document.getElementById('btn-notifications-back').addEventListener('click', () => showView('dashboard'));

document.getElementById('btn-save-notifications').addEventListener('click', async () => {
  const errorEl = document.getElementById('notifications-error');
  const successEl = document.getElementById('notifications-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const btn = document.getElementById('btn-save-notifications');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await api('PUT', '/api/admin/settings', {
      saleNotificationEmails: document.getElementById('field-notification-emails').value.trim(),
      confirmationMessage: document.getElementById('field-confirmation-message').value.trim(),
    });
    successEl.classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
});

// ---------- site (header tagline + countdown) ----------
// The <input type="datetime-local"> field only knows the browser's local
// time zone and has no concept of UTC — the server stores an ISO string
// (UTC) instead, so these two helpers do the conversion at the boundary
// rather than passing local-looking strings around as if they were UTC.

function isoToLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputValueToIso(value) {
  if (!value) return '';
  // `new Date('YYYY-MM-DDTHH:mm')` (no timezone suffix) is parsed as local
  // time by the browser — exactly what the datetime-local input gave us.
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

async function loadSiteSettings() {
  document.getElementById('site-error').classList.add('hidden');
  document.getElementById('site-success').classList.add('hidden');
  const { settings } = await api('GET', '/api/admin/settings');
  document.getElementById('field-header-tagline').value = settings.headerTagline || '';
  document.getElementById('field-countdown-enabled').checked = !!settings.countdownEnabled;
  document.getElementById('field-countdown-label').value = settings.countdownLabel || '';
  document.getElementById('field-countdown-target').value = isoToLocalInputValue(settings.countdownTargetAt);
}

document.getElementById('btn-view-site').addEventListener('click', () => {
  showView('site');
  loadSiteSettings();
});
document.getElementById('btn-site-back').addEventListener('click', () => showView('dashboard'));

document.getElementById('btn-save-site').addEventListener('click', async () => {
  const errorEl = document.getElementById('site-error');
  const successEl = document.getElementById('site-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const countdownEnabled = document.getElementById('field-countdown-enabled').checked;
  const targetValue = document.getElementById('field-countdown-target').value;

  if (countdownEnabled && !targetValue) {
    errorEl.textContent = 'Set a target date/time before turning the countdown on.';
    errorEl.classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('btn-save-site');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await api('PUT', '/api/admin/settings', {
      headerTagline: document.getElementById('field-header-tagline').value.trim(),
      countdownEnabled,
      countdownLabel: document.getElementById('field-countdown-label').value.trim(),
      countdownTargetAt: localInputValueToIso(targetValue),
    });
    successEl.classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
});

// ---------- editor: project fields ----------

function openEditor(project) {
  currentProjectId = project ? project.id : null;
  pendingCoverFile = null;
  pendingTrackFile = null;

  document.getElementById('editor-title').textContent = project ? 'Edit' : 'New Song or Album';
  document.getElementById('field-title').value = project ? project.title : '';
  document.getElementById('field-type').value = project ? project.type : 'single';
  document.getElementById('field-year').value = project ? (project.releaseYear || '') : '';
  document.getElementById('field-description').value = project ? project.description : '';
  document.getElementById('field-sold-out').checked = project ? !!project.soldOut : false;
  const comingSoonChecked = project ? !!project.comingSoon : false;
  document.getElementById('field-coming-soon').checked = comingSoonChecked;
  document.querySelector(`input[name="releaseMode"][value="${project && project.releaseMode === 'auto' ? 'auto' : 'manual'}"]`).checked = true;
  document.getElementById('release-mode-fieldset').classList.toggle('hidden', !comingSoonChecked);

  const pricingMode = project ? project.pricingMode : 'fixed';
  document.querySelector(`input[name="pricingMode"][value="${pricingMode}"]`).checked = true;
  updatePriceLabel();
  document.getElementById('field-price').value = project
    ? (pricingMode === 'fixed' ? (project.fixedPriceCents || 0) / 100 : (project.pwywMinPerTrackCents || 0) / 100)
    : '';

  const coverPreview = document.getElementById('cover-preview');
  const coverText = document.getElementById('cover-dropzone-text');
  if (project && project.coverArtFile) {
    coverPreview.src = `/art/${project.coverArtFile}?t=${Date.now()}`;
    coverPreview.classList.remove('hidden');
    coverText.textContent = 'Drop a new image to replace it';
  } else {
    coverPreview.classList.add('hidden');
    coverText.textContent = 'Drop an image here, or tap to choose one';
  }

  document.getElementById('editor-error').classList.add('hidden');
  document.getElementById('tracks-panel').classList.toggle('hidden', !project);
  document.getElementById('pending-track').classList.add('hidden');

  if (project) renderTracks(project.tracks);

  showView('editor');
}

document.querySelectorAll('input[name="pricingMode"]').forEach((el) => el.addEventListener('change', updatePriceLabel));

// The release-mode choice (manual/auto) only makes sense once Coming soon is
// checked -- keep it hidden otherwise so it doesn't imply a project that's
// already live has some pending auto-release lurking.
document.getElementById('field-coming-soon').addEventListener('change', (e) => {
  document.getElementById('release-mode-fieldset').classList.toggle('hidden', !e.target.checked);
});

function updatePriceLabel() {
  const mode = document.querySelector('input[name="pricingMode"]:checked').value;
  document.getElementById('price-label').textContent = mode === 'fixed' ? 'Price ($)' : 'Minimum per song ($)';
  document.getElementById('pwyw-hint').classList.toggle('hidden', mode !== 'pwyw');
}

document.getElementById('btn-save-project').addEventListener('click', async () => {
  const errorEl = document.getElementById('editor-error');
  errorEl.classList.add('hidden');

  const body = {
    title: document.getElementById('field-title').value.trim(),
    type: document.getElementById('field-type').value,
    releaseYear: document.getElementById('field-year').value.trim(),
    pricingMode: document.querySelector('input[name="pricingMode"]:checked').value,
    price: document.getElementById('field-price').value,
    description: document.getElementById('field-description').value.trim(),
    soldOut: document.getElementById('field-sold-out').checked,
    comingSoon: document.getElementById('field-coming-soon').checked,
    releaseMode: document.querySelector('input[name="releaseMode"]:checked').value,
  };

  if (!body.title) {
    errorEl.textContent = 'Give it a title.';
    errorEl.classList.remove('hidden');
    return;
  }

  const saveBtn = document.getElementById('btn-save-project');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    let project;
    if (currentProjectId) {
      ({ project } = await api('PUT', `/api/admin/projects/${currentProjectId}`, body));
    } else {
      ({ project } = await api('POST', '/api/admin/projects', body));
      currentProjectId = project.id;
    }

    if (pendingCoverFile) {
      await uploadCover(pendingCoverFile);
      pendingCoverFile = null;
    }

    document.getElementById('tracks-panel').classList.remove('hidden');
    document.getElementById('editor-title').textContent = 'Edit';
    renderTracks(project.tracks);
    loadProjects(); // refresh dashboard in the background so it's current when the user goes back
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
});

// ---------- editor: cover art drop zone ----------

const coverDropzone = document.getElementById('cover-dropzone');
const coverFileInput = document.getElementById('cover-file-input');

coverDropzone.addEventListener('click', () => coverFileInput.click());
coverFileInput.addEventListener('change', () => {
  if (coverFileInput.files[0]) handleCoverFile(coverFileInput.files[0]);
});
['dragenter', 'dragover'].forEach((evt) =>
  coverDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    coverDropzone.classList.add('drag-over');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  coverDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    coverDropzone.classList.remove('drag-over');
  })
);
coverDropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleCoverFile(file);
});

function handleCoverFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const preview = document.getElementById('cover-preview');
    preview.src = reader.result;
    preview.classList.remove('hidden');
    document.getElementById('cover-dropzone-text').textContent = 'Looks good — click Save to keep it';
  };
  reader.readAsDataURL(file);

  if (currentProjectId) {
    uploadCover(file);
  } else {
    pendingCoverFile = file; // uploaded right after the project itself is created
  }
}

async function uploadCover(file) {
  const formData = new FormData();
  formData.append('cover', file);
  await api('POST', `/api/admin/projects/${currentProjectId}/cover`, formData);
}

// ---------- editor: tracks ----------

function renderTracks(tracks) {
  const listEl = document.getElementById('track-list');
  listEl.innerHTML = '';

  if (!tracks.length) {
    listEl.innerHTML = '<p class="admin-hint">No songs yet — drop one in below.</p>';
    return;
  }

  tracks.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = 'admin-track-row';
    row.innerHTML = `
      <div class="admin-track-order">
        <button class="btn-up" ${index === 0 ? 'disabled' : ''}>&and;</button>
        <button class="btn-down" ${index === tracks.length - 1 ? 'disabled' : ''}>&or;</button>
      </div>
      <div class="admin-track-title-wrap">
        <input type="text" value="${track.title.replace(/"/g, '&quot;')}" />
        <div class="admin-track-meta">${formatDuration(track.durationSeconds)}${track.previewAudioFile ? '' : ' · no preview clip'}</div>
      </div>
      <label class="admin-track-released-toggle">
        <input type="checkbox" ${track.released ? 'checked' : ''} />
        Live
      </label>
      <button class="admin-track-delete">Delete</button>
    `;

    row.querySelector('.btn-up').addEventListener('click', () => reorderTrack(track.id, 'up'));
    row.querySelector('.btn-down').addEventListener('click', () => reorderTrack(track.id, 'down'));
    row.querySelector('input[type="text"]').addEventListener('change', (e) =>
      updateTrack(track.id, { title: e.target.value })
    );
    row.querySelector('input[type="checkbox"]').addEventListener('change', (e) =>
      updateTrack(track.id, { released: e.target.checked })
    );
    row.querySelector('.admin-track-delete').addEventListener('click', () => deleteTrack(track.id, track.title));

    listEl.appendChild(row);
  });
}

async function updateTrack(trackId, fields) {
  const { project } = await api('PUT', `/api/admin/tracks/${trackId}`, fields);
  renderTracks(project.tracks);
}

async function deleteTrack(trackId, title) {
  if (!confirm(`Delete "${title}"? This can't be undone.`)) return;
  const { project } = await api('DELETE', `/api/admin/tracks/${trackId}`);
  renderTracks(project.tracks);
  loadProjects();
}

async function reorderTrack(trackId, direction) {
  const { project } = await api('POST', `/api/admin/tracks/${trackId}/reorder`, { direction });
  renderTracks(project.tracks);
}

// ---------- editor: track drop zone ----------

const trackDropzone = document.getElementById('track-dropzone');
const trackFileInput = document.getElementById('track-file-input');

trackDropzone.addEventListener('click', () => trackFileInput.click());
trackFileInput.addEventListener('change', () => {
  if (trackFileInput.files[0]) handleTrackFile(trackFileInput.files[0]);
});
['dragenter', 'dragover'].forEach((evt) =>
  trackDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    trackDropzone.classList.add('drag-over');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  trackDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    trackDropzone.classList.remove('drag-over');
  })
);
trackDropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleTrackFile(file);
});

function handleTrackFile(file) {
  pendingTrackFile = file;
  document.querySelector('.admin-pending-filename').textContent = file.name;
  document.getElementById('pending-track-title').value = titleFromFilename(file.name);
  document.getElementById('pending-track-released').checked = true;
  document.getElementById('track-upload-status').textContent = '';
  document.getElementById('pending-track').classList.remove('hidden');
}

document.getElementById('btn-cancel-track').addEventListener('click', () => {
  pendingTrackFile = null;
  trackFileInput.value = '';
  document.getElementById('pending-track').classList.add('hidden');
});

document.getElementById('btn-confirm-track').addEventListener('click', async () => {
  if (!pendingTrackFile) return;
  const btn = document.getElementById('btn-confirm-track');
  const statusEl = document.getElementById('track-upload-status');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  statusEl.textContent = 'This can take a little while for longer songs.';

  try {
    const formData = new FormData();
    formData.append('audio', pendingTrackFile);
    formData.append('title', document.getElementById('pending-track-title').value.trim() || titleFromFilename(pendingTrackFile.name));
    formData.append('released', document.getElementById('pending-track-released').checked);

    const { project, warning } = await api('POST', `/api/admin/projects/${currentProjectId}/tracks`, formData);

    renderTracks(project.tracks);
    loadProjects();
    pendingTrackFile = null;
    trackFileInput.value = '';
    document.getElementById('pending-track').classList.add('hidden');
    if (warning) alert(warning);
  } catch (err) {
    statusEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add Song';
  }
});

// ---------- leaderboard (Feature Contest) ----------

let editingLeaderboardId = null; // null while adding a brand-new entry

async function loadLeaderboardSettings() {
  document.getElementById('leaderboard-settings-error').classList.add('hidden');
  document.getElementById('leaderboard-settings-success').classList.add('hidden');
  const { settings } = await api('GET', '/api/admin/settings');
  document.getElementById('field-leaderboard-visible').checked = !!settings.leaderboardVisible;
  const mode = settings.leaderboardSortMode === 'rank' ? 'rank' : 'date';
  document.querySelector(`input[name="leaderboardSortMode"][value="${mode}"]`).checked = true;
  document.getElementById('field-spotify-playlist').value = settings.spotifyPlaylistId || '';
  document.getElementById('field-leaderboard-heading').value = settings.leaderboardHeading || '';
  document.getElementById('field-leaderboard-subheading').value = settings.leaderboardSubheading || '';
  document.getElementById('field-leaderboard-thumbs-enabled').checked = !!settings.leaderboardThumbsEnabled;
  document.getElementById('field-leaderboard-thumbs-limit-one').checked = !!settings.leaderboardThumbsLimitOne;
  const contestRound = ['pool', 'top10', 'top3', 'winner'].includes(settings.leaderboardContestRound)
    ? settings.leaderboardContestRound
    : 'pool';
  document.querySelector(`input[name="leaderboardContestRound"][value="${contestRound}"]`).checked = true;
  document.getElementById('field-leaderboard-honorable-mentions').checked = !!settings.leaderboardShowHonorableMentions;
}

document.getElementById('btn-view-leaderboard').addEventListener('click', () => {
  showView('leaderboard');
  loadLeaderboardSettings();
  loadLeaderboardEntries();
  resetLeaderboardForm();
});
document.getElementById('btn-leaderboard-back').addEventListener('click', () => showView('dashboard'));

document.getElementById('btn-save-leaderboard-settings').addEventListener('click', async () => {
  const errorEl = document.getElementById('leaderboard-settings-error');
  const successEl = document.getElementById('leaderboard-settings-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const btn = document.getElementById('btn-save-leaderboard-settings');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await api('PUT', '/api/admin/settings', {
      leaderboardVisible: document.getElementById('field-leaderboard-visible').checked,
      leaderboardSortMode: document.querySelector('input[name="leaderboardSortMode"]:checked').value,
      spotifyPlaylistLink: document.getElementById('field-spotify-playlist').value.trim(),
      leaderboardHeading: document.getElementById('field-leaderboard-heading').value.trim(),
      leaderboardSubheading: document.getElementById('field-leaderboard-subheading').value.trim(),
      leaderboardThumbsEnabled: document.getElementById('field-leaderboard-thumbs-enabled').checked,
      leaderboardThumbsLimitOne: document.getElementById('field-leaderboard-thumbs-limit-one').checked,
      leaderboardContestRound: document.querySelector('input[name="leaderboardContestRound"]:checked').value,
      leaderboardShowHonorableMentions: document.getElementById('field-leaderboard-honorable-mentions').checked,
    });
    successEl.classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
});

async function loadLeaderboardEntries() {
  const listEl = document.getElementById('leaderboard-list');
  listEl.innerHTML = '<p class="admin-loading">Loading…</p>';
  const { entries } = await api('GET', '/api/admin/leaderboard');
  renderLeaderboardList(entries);
}

const ROUND_LABELS = { pool: 'Open Pool', top10: 'Top 10', top3: 'Top 3' };

function renderLeaderboardList(entries) {
  const listEl = document.getElementById('leaderboard-list');

  if (!entries.length) {
    listEl.innerHTML = '<p class="admin-empty">No picks yet — add one above after the next stream.</p>';
    return;
  }

  listEl.innerHTML = '';
  entries.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'admin-project-row';
    row.innerHTML = `
      <div class="admin-track-order" title="Manual rank order — only used on the site when Public page order is set to Rank">
        <button class="btn-up" ${index === 0 ? 'disabled' : ''}>&and;</button>
        <button class="btn-down" ${index === entries.length - 1 ? 'disabled' : ''}>&or;</button>
      </div>
      <div class="admin-project-info">
        <h3>${entry.artist} — ${entry.songTitle}${entry.isWinner ? ' <span class="admin-featured-badge">🏆 Winner</span>' : ''}${entry.streamTopPick ? ' <span class="admin-soldout-badge" style="background: var(--accent);">⭐ Kyle\'s Top 3</span>' : ''}</h3>
        <p>Stream date: ${entry.streamDate}${entry.link ? ' · has a link' : ''} · 😊 ${entry.thumbsCount} · Round: ${ROUND_LABELS[entry.round] || 'Open Pool'}</p>
      </div>
      <div class="admin-project-row-actions" style="flex-wrap: wrap; justify-content: flex-end;">
        <select class="admin-round-select" title="Contest-wide round for this entry" ${entry.isWinner ? 'disabled' : ''}>
          <option value="pool" ${entry.round === 'pool' ? 'selected' : ''}>Open Pool</option>
          <option value="top10" ${entry.round === 'top10' ? 'selected' : ''}>Top 10</option>
          <option value="top3" ${entry.round === 'top3' ? 'selected' : ''}>Top 3</option>
        </select>
        <button class="admin-btn-ghost btn-stream-pick">${entry.streamTopPick ? "Remove Kyle's Top 3" : "⭐ Mark as Kyle's Top 3"}</button>
        <button class="admin-btn-ghost btn-winner">${entry.isWinner ? 'Remove Winner' : 'Mark Winner'}</button>
        <button class="admin-btn-ghost btn-edit">Edit</button>
        <button class="admin-btn-ghost btn-delete">Delete</button>
      </div>
    `;
    row.querySelector('.btn-up').addEventListener('click', () => reorderLeaderboardEntry(entry.id, 'up'));
    row.querySelector('.btn-down').addEventListener('click', () => reorderLeaderboardEntry(entry.id, 'down'));
    row.querySelector('.btn-winner').addEventListener('click', () => toggleLeaderboardWinner(entry));
    row.querySelector('.btn-stream-pick').addEventListener('click', () => toggleLeaderboardStreamTopPick(entry));
    row.querySelector('.admin-round-select').addEventListener('change', (e) => setLeaderboardEntryRound(entry.id, e.target.value));
    row.querySelector('.btn-edit').addEventListener('click', () => openLeaderboardEditForm(entry));
    row.querySelector('.btn-delete').addEventListener('click', () => deleteLeaderboardEntry(entry));
    listEl.appendChild(row);
  });
}

async function reorderLeaderboardEntry(id, direction) {
  const { entries } = await api('POST', `/api/admin/leaderboard/${id}/reorder`, { direction });
  renderLeaderboardList(entries);
}

async function toggleLeaderboardWinner(entry) {
  const body = entry.isWinner ? { clear: true } : {};
  const { entries } = await api('POST', `/api/admin/leaderboard/${entry.id}/winner`, body);
  renderLeaderboardList(entries);
  // Marking a winner flips the contest round to "Winner Announced" on the
  // server (see db.setLeaderboardWinner) — refresh the settings panel so the
  // Contest round radio doesn't sit stale and get accidentally saved back to
  // an earlier round the next time Kyle hits Save up there.
  if (!entry.isWinner) loadLeaderboardSettings();
}

async function setLeaderboardEntryRound(id, round) {
  const { entries } = await api('POST', `/api/admin/leaderboard/${id}/round`, { round });
  renderLeaderboardList(entries);
}

async function toggleLeaderboardStreamTopPick(entry) {
  const { entries } = await api('POST', `/api/admin/leaderboard/${entry.id}/stream-top-pick`, { value: !entry.streamTopPick });
  renderLeaderboardList(entries);
}

async function deleteLeaderboardEntry(entry) {
  if (!confirm(`Delete the pick "${entry.artist} — ${entry.songTitle}"? This can't be undone.`)) return;
  await api('DELETE', `/api/admin/leaderboard/${entry.id}`);
  loadLeaderboardEntries();
}

function resetLeaderboardForm() {
  editingLeaderboardId = null;
  document.getElementById('field-lb-artist').value = '';
  document.getElementById('field-lb-song').value = '';
  document.getElementById('field-lb-date').value = '';
  document.getElementById('field-lb-link').value = '';
  document.getElementById('leaderboard-entry-error').classList.add('hidden');
  document.getElementById('btn-save-lb-entry').textContent = 'Add to leaderboard';
  document.getElementById('btn-cancel-lb-entry').classList.add('hidden');
}

function openLeaderboardEditForm(entry) {
  editingLeaderboardId = entry.id;
  document.getElementById('field-lb-artist').value = entry.artist;
  document.getElementById('field-lb-song').value = entry.songTitle;
  document.getElementById('field-lb-date').value = entry.streamDate;
  document.getElementById('field-lb-link').value = entry.link || '';
  document.getElementById('btn-save-lb-entry').textContent = 'Save changes';
  document.getElementById('btn-cancel-lb-entry').classList.remove('hidden');
  document.getElementById('field-lb-artist').focus();
}

document.getElementById('btn-cancel-lb-entry').addEventListener('click', resetLeaderboardForm);

document.getElementById('btn-save-lb-entry').addEventListener('click', async () => {
  const errorEl = document.getElementById('leaderboard-entry-error');
  errorEl.classList.add('hidden');

  const payload = {
    artist: document.getElementById('field-lb-artist').value.trim(),
    songTitle: document.getElementById('field-lb-song').value.trim(),
    streamDate: document.getElementById('field-lb-date').value,
    link: document.getElementById('field-lb-link').value.trim(),
  };

  const btn = document.getElementById('btn-save-lb-entry');
  btn.disabled = true;
  btn.textContent = editingLeaderboardId ? 'Saving…' : 'Adding…';

  try {
    if (editingLeaderboardId) {
      await api('PUT', `/api/admin/leaderboard/${editingLeaderboardId}`, payload);
    } else {
      await api('POST', '/api/admin/leaderboard', payload);
    }
    resetLeaderboardForm();
    loadLeaderboardEntries();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = editingLeaderboardId ? 'Save changes' : 'Add to leaderboard';
  }
});

boot();
