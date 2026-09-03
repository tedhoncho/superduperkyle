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

function salesAttr(value) {
  return String(value ?? '').replace(/"/g, '&quot;');
}

// Full, unfiltered (date-range-only) rows from the last /api/admin/sales
// call. Column filters below run against this in memory -- no extra
// server round trip per keystroke/selection.
let allSalesRows = [];

async function loadSales() {
  const wrap = document.getElementById('sales-table-wrap');
  wrap.innerHTML = '<p class="admin-loading">Loading…</p>';
  document.getElementById('btn-export-sales').href = `/api/admin/sales/export.csv${salesQueryString()}`;

  const { sales } = await api('GET', `/api/admin/sales${salesQueryString()}`);
  allSalesRows = sales;
  renderSales(sales);
}

function renderSales(sales) {
  const wrap = document.getElementById('sales-table-wrap');
  if (!sales.length) {
    document.getElementById('sales-summary').innerHTML = `
      <div class="admin-sales-metric"><span>0</span>Sales</div>
      <div class="admin-sales-metric"><span>${money(0)}</span>Total revenue</div>
    `;
    wrap.innerHTML = '<p class="admin-empty">No sales in this range yet.</p>';
    return;
  }

  // Dropdown filters only offer values that actually appear in this date
  // range, so Ted never picks a project/status that returns nothing.
  const projectOptions = [...new Set(sales.map((s) => s.projectTitle))].sort();
  const typeOptions = [...new Set(sales.map((s) => s.projectType))].sort();
  const statusOptions = [...new Set(sales.map((s) => s.status))].sort();

  wrap.innerHTML = `
    <table class="admin-sales-table">
      <thead>
        <tr><th>Order #</th><th>Date &amp; time</th><th>Project</th><th>Type</th><th>Customer</th><th>Amount</th><th>Status</th></tr>
        <tr class="admin-sales-filter-row">
          <th><input type="text" class="admin-sales-col-filter" data-col="orderNumber" placeholder="Filter…" /></th>
          <th></th>
          <th>
            <select class="admin-sales-col-filter" data-col="projectTitle">
              <option value="">All</option>
              ${projectOptions.map((p) => `<option value="${salesAttr(p)}">${p}</option>`).join('')}
            </select>
          </th>
          <th>
            <select class="admin-sales-col-filter" data-col="projectType">
              <option value="">All</option>
              ${typeOptions.map((t) => `<option value="${salesAttr(t)}">${t}</option>`).join('')}
            </select>
          </th>
          <th><input type="text" class="admin-sales-col-filter" data-col="email" placeholder="Filter…" /></th>
          <th></th>
          <th>
            <select class="admin-sales-col-filter" data-col="status">
              <option value="">All</option>
              ${statusOptions.map((s) => `<option value="${salesAttr(s)}">${s}</option>`).join('')}
            </select>
          </th>
        </tr>
      </thead>
      <tbody id="sales-table-body"></tbody>
    </table>
  `;

  wrap.querySelectorAll('.admin-sales-col-filter').forEach((el) => {
    el.addEventListener('input', applySalesColumnFilters);
    el.addEventListener('change', applySalesColumnFilters);
  });

  applySalesColumnFilters();
}

// Re-filters allSalesRows using whatever's currently typed/selected in the
// header filter row, then repaints just the summary tiles + tbody -- never
// the thead/filter controls themselves, so typing in one box never loses
// focus or resets what's typed in the others.
function applySalesColumnFilters() {
  const wrap = document.getElementById('sales-table-wrap');
  const filters = {};
  wrap.querySelectorAll('.admin-sales-col-filter').forEach((el) => {
    const v = el.value.trim();
    if (v) filters[el.dataset.col] = v.toLowerCase();
  });

  const exactMatchCols = new Set(['projectTitle', 'projectType', 'status']);
  const filtered = allSalesRows.filter((row) =>
    Object.entries(filters).every(([col, value]) => {
      const cell = String(row[col] ?? '').toLowerCase();
      return exactMatchCols.has(col) ? cell === value : cell.includes(value);
    })
  );

  renderSalesRows(filtered);
}

function renderSalesRows(sales) {
  const totalRevenueCents = sales.reduce((sum, s) => sum + s.amountCents, 0);
  document.getElementById('sales-summary').innerHTML = `
    <div class="admin-sales-metric"><span>${sales.length}</span>Sale${sales.length === 1 ? '' : 's'}</div>
    <div class="admin-sales-metric"><span>${money(totalRevenueCents)}</span>Total revenue</div>
  `;

  const tbody = document.getElementById('sales-table-body');
  if (!tbody) return;
  if (!sales.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">No sales match these filters.</td></tr>';
    return;
  }

  tbody.innerHTML = sales
    .map((s) => {
      const date = formatDateTime(s.fulfilledAt || s.createdAt);
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
    .join('');
}

document.getElementById('btn-view-sales').addEventListener('click', () => {
  showView('sales');
  showSalesSubtab('completed');
});
document.getElementById('btn-sales-back').addEventListener('click', () => showView('dashboard'));
document.getElementById('btn-sales-filter').addEventListener('click', loadSales);
document.getElementById('btn-sales-clear').addEventListener('click', () => {
  document.getElementById('sales-from').value = '';
  document.getElementById('sales-to').value = '';
  loadSales();
});

// Two sub-tabs under one Sales section: Completed (existing date-ranged
// report) and Pending Carts (abandoned checkouts, unfiltered -- see
// loadPendingCarts). Export CSV only makes sense for Completed today, so it
// hides on the Pending Carts tab rather than exporting something it can't.
function showSalesSubtab(tab) {
  const isCompleted = tab === 'completed';
  document.getElementById('sales-panel-completed').classList.toggle('hidden', !isCompleted);
  document.getElementById('sales-panel-pending').classList.toggle('hidden', isCompleted);
  document.getElementById('btn-sales-subtab-completed').classList.toggle('is-active', isCompleted);
  document.getElementById('btn-sales-subtab-pending').classList.toggle('is-active', !isCompleted);
  document.getElementById('btn-export-sales').classList.toggle('hidden', !isCompleted);
  if (isCompleted) loadSales();
  else loadPendingCarts();
}
document.getElementById('btn-sales-subtab-completed').addEventListener('click', () => showSalesSubtab('completed'));
document.getElementById('btn-sales-subtab-pending').addEventListener('click', () => showSalesSubtab('pending'));

// SQLite's datetime('now') stores UTC with no timezone suffix (e.g.
// "2026-09-03 14:22:00") -- appending Z makes JS parse it correctly instead
// of silently misreading it as local time. Renders in the viewing browser's
// own locale/timezone, date and time both.
function formatDateTime(sqliteDateStr) {
  if (!sqliteDateStr) return '—';
  const d = new Date(`${sqliteDateStr.replace(' ', 'T')}Z`);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function timeAgo(sqliteDateStr) {
  const ms = Date.now() - new Date(`${sqliteDateStr.replace(' ', 'T')}Z`).getTime();
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function loadPendingCarts() {
  const wrap = document.getElementById('pending-table-wrap');
  wrap.innerHTML = '<p class="admin-loading">Loading…</p>';
  const { pending } = await api('GET', '/api/admin/sales/pending');
  renderPendingCarts(pending);
}

function renderPendingCarts(pending) {
  const totalCents = pending.reduce((sum, o) => sum + o.amountCents, 0);
  document.getElementById('pending-summary').innerHTML = `
    <div class="admin-sales-metric"><span>${pending.length}</span>Pending cart${pending.length === 1 ? '' : 's'}</div>
    <div class="admin-sales-metric"><span>${money(totalCents)}</span>Potential revenue</div>
  `;

  const wrap = document.getElementById('pending-table-wrap');
  if (!pending.length) {
    wrap.innerHTML = '<p class="admin-empty">No pending carts right now.</p>';
    return;
  }

  wrap.innerHTML = `
    <table class="admin-sales-table">
      <thead>
        <tr><th>Order #</th><th>Started</th><th>Project</th><th>Customer</th><th>Amount</th><th>Reminder sent?</th><th></th></tr>
      </thead>
      <tbody>
        ${pending
          .map(
            (o) => `
              <tr>
                <td>${o.orderNumber || '—'}</td>
                <td>${timeAgo(o.createdAt)}</td>
                <td>${o.projectTitle}</td>
                <td>${o.email}</td>
                <td>${money(o.amountCents)}</td>
                <td>${o.reminderSentAt ? 'Yes' : 'Not yet'}</td>
                <td><button class="admin-btn-ghost btn-send-reminder" data-order-id="${salesAttr(o.stripeSessionId)}">${
                  o.reminderSentAt ? 'Resend' : 'Send reminder'
                }</button></td>
              </tr>
            `
          )
          .join('')}
      </tbody>
    </table>
  `;
}

// Event delegation on the table wrap -- rows get rebuilt on every
// loadPendingCarts() call, so listeners are attached here once rather than
// re-bound per render.
document.getElementById('pending-table-wrap').addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-send-reminder');
  if (!btn) return;

  const statusEl = document.getElementById('pending-action-status');
  statusEl.classList.add('hidden');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Sending…';

  try {
    const data = await api('POST', `/api/admin/sales/pending/${encodeURIComponent(btn.dataset.orderId)}/remind`);
    statusEl.textContent = data.alreadyPaid
      ? 'Stripe already shows this one as paid -- fulfilled it instead of sending a reminder.'
      : 'Reminder email sent.';
    statusEl.classList.remove('hidden');
    loadPendingCarts();
  } catch (err) {
    statusEl.textContent = err.message || 'Something went wrong sending the reminder.';
    statusEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
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
  document.getElementById('field-leaderboard-stream-embed').checked = !!settings.leaderboardStreamEmbedEnabled;
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
      leaderboardStreamEmbedEnabled: document.getElementById('field-leaderboard-stream-embed').checked,
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
    row.className = 'admin-project-row admin-lb-row';
    row.innerHTML = `
      <div class="admin-lb-row-main">
        <div class="admin-track-order" title="Manual rank order — only used on the site when Public page order is set to Rank">
          <button class="btn-up" ${index === 0 ? 'disabled' : ''}>&and;</button>
          <button class="btn-down" ${index === entries.length - 1 ? 'disabled' : ''}>&or;</button>
        </div>
        <div class="admin-project-info">
          <h3>${entry.artist} — ${entry.songTitle}${entry.isWinner ? ' <span class="admin-featured-badge">🏆 Winner</span>' : ''}${entry.streamTopPick ? ' <span class="admin-soldout-badge" style="background: var(--accent);">⭐ Kyle\'s Top 3</span>' : ''}</h3>
          <p>Stream date: ${entry.streamDate}${entry.link ? ' · has a link' : ''}${entry.hasAudio ? ' · 🎵 has audio' : ''} · 😊 ${entry.thumbsCount} · Round: ${ROUND_LABELS[entry.round] || 'Open Pool'}</p>
        </div>
      </div>
      <div class="admin-project-row-actions">
        <select class="admin-round-select" title="Contest-wide round for this entry" ${entry.isWinner ? 'disabled' : ''}>
          <option value="pool" ${entry.round === 'pool' ? 'selected' : ''}>Open Pool</option>
          <option value="top10" ${entry.round === 'top10' ? 'selected' : ''}>Top 10</option>
          <option value="top3" ${entry.round === 'top3' ? 'selected' : ''}>Top 3</option>
        </select>
        <button class="admin-btn-ghost btn-stream-pick">${entry.streamTopPick ? "Remove Kyle's Top 3" : "⭐ Mark as Kyle's Top 3"}</button>
        <button class="admin-btn-ghost btn-winner">${entry.isWinner ? 'Remove Winner' : 'Mark Winner'}</button>
        <input type="file" class="lb-audio-swap-input hidden" accept=".mp3,.wav,.flac,.m4a,.aac,.ogg,.wma" />
        <button class="admin-btn-ghost btn-swap-audio" title="Upload a new mp3 for this entry right now — no need to open Edit">${entry.hasAudio ? '🎵 Swap song' : '🎵 Add song'}</button>
        ${entry.hasAudio ? '<button class="admin-btn-ghost btn-remove-audio">Remove song</button>' : ''}
        <button class="admin-btn-ghost btn-edit">Edit</button>
        <button class="admin-btn-ghost btn-delete">Delete</button>
      </div>
    `;
    row.querySelector('.btn-up').addEventListener('click', () => reorderLeaderboardEntry(entry.id, 'up'));
    row.querySelector('.btn-down').addEventListener('click', () => reorderLeaderboardEntry(entry.id, 'down'));
    row.querySelector('.btn-winner').addEventListener('click', () => toggleLeaderboardWinner(entry));
    row.querySelector('.btn-stream-pick').addEventListener('click', () => toggleLeaderboardStreamTopPick(entry));
    row.querySelector('.admin-round-select').addEventListener('change', (e) => setLeaderboardEntryRound(entry.id, e.target.value));
    const swapInput = row.querySelector('.lb-audio-swap-input');
    const swapBtn = row.querySelector('.btn-swap-audio');
    swapBtn.addEventListener('click', () => swapInput.click());
    swapInput.addEventListener('change', () => {
      if (swapInput.files[0]) swapLeaderboardAudio(entry, swapInput.files[0], swapBtn);
    });
    const removeAudioBtn = row.querySelector('.btn-remove-audio');
    if (removeAudioBtn) removeAudioBtn.addEventListener('click', () => removeLeaderboardAudio(entry, removeAudioBtn));
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

// Straight-from-the-row swap: pick a new mp3 and it's live immediately, no
// need to open Edit first. Carries the entry's existing artist/songTitle/
// streamDate/link through unchanged -- this only ever touches the audio.
async function swapLeaderboardAudio(entry, file, btn) {
  const formData = new FormData();
  formData.append('artist', entry.artist);
  formData.append('songTitle', entry.songTitle);
  formData.append('streamDate', entry.streamDate);
  formData.append('link', entry.link || '');
  formData.append('audio', file);

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    await api('PUT', `/api/admin/leaderboard/${entry.id}`, formData);
    loadLeaderboardEntries();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Straight-from-the-row removal -- clears just the audio, entry stays.
async function removeLeaderboardAudio(entry, btn) {
  if (!confirm(`Remove the mp3 from "${entry.artist} — ${entry.songTitle}"? The entry itself stays — this only clears the audio.`)) return;
  const formData = new FormData();
  formData.append('artist', entry.artist);
  formData.append('songTitle', entry.songTitle);
  formData.append('streamDate', entry.streamDate);
  formData.append('link', entry.link || '');
  formData.append('removeAudio', 'true');

  btn.disabled = true;
  try {
    await api('PUT', `/api/admin/leaderboard/${entry.id}`, formData);
    loadLeaderboardEntries();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
}

function resetLeaderboardForm() {
  editingLeaderboardId = null;
  document.getElementById('field-lb-artist').value = '';
  document.getElementById('field-lb-song').value = '';
  document.getElementById('field-lb-date').value = '';
  document.getElementById('field-lb-link').value = '';
  document.getElementById('field-lb-audio').value = '';
  document.getElementById('field-lb-remove-audio').checked = false;
  document.getElementById('lb-current-audio').classList.add('hidden');
  document.getElementById('lb-remove-audio-row').classList.add('hidden');
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
  document.getElementById('field-lb-audio').value = '';
  document.getElementById('field-lb-remove-audio').checked = false;
  const currentAudioEl = document.getElementById('lb-current-audio');
  const removeRowEl = document.getElementById('lb-remove-audio-row');
  if (entry.hasAudio) {
    currentAudioEl.textContent = 'This entry already has an mp3 attached — uploading a new one replaces it.';
    currentAudioEl.classList.remove('hidden');
    removeRowEl.classList.remove('hidden');
  } else {
    currentAudioEl.classList.add('hidden');
    removeRowEl.classList.add('hidden');
  }
  document.getElementById('btn-save-lb-entry').textContent = 'Save changes';
  document.getElementById('btn-cancel-lb-entry').classList.remove('hidden');
  document.getElementById('field-lb-artist').focus();
}

document.getElementById('btn-cancel-lb-entry').addEventListener('click', resetLeaderboardForm);

document.getElementById('btn-save-lb-entry').addEventListener('click', async () => {
  const errorEl = document.getElementById('leaderboard-entry-error');
  errorEl.classList.add('hidden');

  const formData = new FormData();
  formData.append('artist', document.getElementById('field-lb-artist').value.trim());
  formData.append('songTitle', document.getElementById('field-lb-song').value.trim());
  formData.append('streamDate', document.getElementById('field-lb-date').value);
  formData.append('link', document.getElementById('field-lb-link').value.trim());
  const audioFile = document.getElementById('field-lb-audio').files[0];
  if (audioFile) formData.append('audio', audioFile);
  if (document.getElementById('field-lb-remove-audio').checked) formData.append('removeAudio', 'true');

  const btn = document.getElementById('btn-save-lb-entry');
  btn.disabled = true;
  btn.textContent = editingLeaderboardId ? 'Saving…' : 'Adding…';

  try {
    if (editingLeaderboardId) {
      await api('PUT', `/api/admin/leaderboard/${editingLeaderboardId}`, formData);
    } else {
      await api('POST', '/api/admin/leaderboard', formData);
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

// ---------- leaderboard Danger Zone ----------
// Two separate destructive actions, each behind three layers of friction
// (Ted specifically asked for more than the single confirm() dialog the
// rest of the admin panel uses): open the panel to see the exact stats
// first, type an exact phrase, then a final native confirm() before
// anything actually happens. The phrase itself is also checked
// server-side, so this can't be forced by replaying a request either.

async function refreshLeaderboardAudioStats(targetEl) {
  const { count, totalBytes } = await api('GET', '/api/admin/leaderboard/audio-usage');
  const mb = (totalBytes / (1024 * 1024)).toFixed(1);
  targetEl.textContent = count
    ? `${count} submission${count === 1 ? '' : 's'} currently have audio attached — about ${mb} MB will be freed.`
    : 'No submission audio is currently stored — nothing to clear.';
}

document.getElementById('btn-open-clear-audio').addEventListener('click', async () => {
  document.getElementById('field-clear-audio-phrase').value = '';
  document.getElementById('clear-audio-error').classList.add('hidden');
  document.getElementById('clear-audio-panel').classList.remove('hidden');
  await refreshLeaderboardAudioStats(document.getElementById('clear-audio-stats'));
});

document.getElementById('btn-cancel-clear-audio').addEventListener('click', () => {
  document.getElementById('clear-audio-panel').classList.add('hidden');
});

document.getElementById('btn-confirm-clear-audio').addEventListener('click', async () => {
  const errorEl = document.getElementById('clear-audio-error');
  errorEl.classList.add('hidden');
  const phrase = document.getElementById('field-clear-audio-phrase').value.trim();
  if (phrase !== 'CLEAR AUDIO') {
    errorEl.textContent = 'Type it exactly: CLEAR AUDIO';
    errorEl.classList.remove('hidden');
    return;
  }
  if (!confirm('Final check: permanently delete every submission mp3? Entries, links, and vote history stay — only the audio files go. This cannot be undone.')) return;

  const btn = document.getElementById('btn-confirm-clear-audio');
  btn.disabled = true;
  try {
    const { cleared } = await api('POST', '/api/admin/leaderboard/clear-audio', { confirmPhrase: phrase });
    document.getElementById('clear-audio-panel').classList.add('hidden');
    loadLeaderboardEntries();
    alert(`Cleared audio from ${cleared} submission${cleared === 1 ? '' : 's'}.`);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-open-delete-all').addEventListener('click', async () => {
  document.getElementById('field-delete-all-phrase').value = '';
  document.getElementById('delete-all-error').classList.add('hidden');
  document.getElementById('delete-all-panel').classList.remove('hidden');
  const { entries } = await api('GET', '/api/admin/leaderboard');
  document.getElementById('delete-all-stats').textContent = entries.length
    ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} — including any winner, round, and vote history — will be permanently deleted.`
    : 'No entries exist right now — nothing to delete.';
});

document.getElementById('btn-cancel-delete-all').addEventListener('click', () => {
  document.getElementById('delete-all-panel').classList.add('hidden');
});

document.getElementById('btn-confirm-delete-all').addEventListener('click', async () => {
  const errorEl = document.getElementById('delete-all-error');
  errorEl.classList.add('hidden');
  const phrase = document.getElementById('field-delete-all-phrase').value.trim();
  if (phrase !== 'DELETE ALL ENTRIES') {
    errorEl.textContent = 'Type it exactly: DELETE ALL ENTRIES';
    errorEl.classList.remove('hidden');
    return;
  }
  if (!confirm('Final check: permanently delete every leaderboard entry and all their history? This cannot be undone.')) return;

  const btn = document.getElementById('btn-confirm-delete-all');
  btn.disabled = true;
  try {
    const { deleted } = await api('POST', '/api/admin/leaderboard/delete-all', { confirmPhrase: phrase });
    document.getElementById('delete-all-panel').classList.add('hidden');
    loadLeaderboardEntries();
    alert(`Deleted ${deleted} entr${deleted === 1 ? 'y' : 'ies'}.`);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

boot();
