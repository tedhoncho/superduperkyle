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
        <h3>${project.title}${index === 0 ? ' <span class="admin-featured-badge">Featured</span>' : ''}</h3>
        <p>${project.tracks.length} song${project.tracks.length === 1 ? '' : 's'} (${releasedCount} live) · ${priceLabel}</p>
      </div>
      <div class="admin-project-row-actions">
        <button class="admin-btn-ghost btn-edit">Edit</button>
        <button class="admin-btn-ghost btn-delete">Delete</button>
      </div>
    `;
    row.querySelector('.btn-up').addEventListener('click', () => reorderProject(project.id, 'up'));
    row.querySelector('.btn-down').addEventListener('click', () => reorderProject(project.id, 'down'));
    row.querySelector('.btn-edit').addEventListener('click', () => openEditor(project));
    row.querySelector('.btn-delete').addEventListener('click', () => deleteProject(project));
    listEl.appendChild(row);
  });
}

async function reorderProject(projectId, direction) {
  const { projects } = await api('POST', `/api/admin/projects/${projectId}/reorder`, { direction });
  renderProjectList(projects);
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

boot();
