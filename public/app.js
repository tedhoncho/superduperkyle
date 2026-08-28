const catalogEl = document.getElementById('catalog');

const modalBackdrop = document.getElementById('modal-backdrop');
const modalArt = document.getElementById('modal-art');
const modalTitle = document.getElementById('modal-title');
const modalSubtitle = document.getElementById('modal-subtitle');
const modalPriceFixed = document.getElementById('modal-price-fixed');
const modalFixedPrice = document.getElementById('modal-fixed-price');
const modalPricePwyw = document.getElementById('modal-price-pwyw');
const modalPwywNote = document.getElementById('modal-pwyw-note');
const modalAmountButtons = document.getElementById('modal-amount-buttons');
const modalAmountInput = document.getElementById('modal-amount-input');
const modalEmail = document.getElementById('modal-email');
const modalPayButton = document.getElementById('modal-pay-button');
const modalError = document.getElementById('modal-error');

let currentProject = null;
let currentAudio = null;
let currentPreviewButton = null;

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function loadCatalog() {
  const res = await fetch('/api/catalog');
  const data = await res.json();
  renderCatalog(data.projects);
}

// --- Header tagline + release countdown ---
// Both are set from the admin "Site" tab. The server only ever sends a
// countdown object while it's genuinely still counting down (see
// /api/site-settings), so this code doesn't need to reason about "expired"
// vs. "disabled" itself — no countdown in the response just means don't
// show the banner.
let countdownTimer = null;

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  document.getElementById('countdown-banner').classList.add('hidden');
}

function startCountdown(label, targetAt) {
  const banner = document.getElementById('countdown-banner');
  const labelEl = document.getElementById('countdown-label');
  const clockEl = document.getElementById('countdown-clock');
  const target = new Date(targetAt).getTime();

  labelEl.textContent = label || 'New release drops in:';
  banner.classList.remove('hidden');

  function tick() {
    const remainingMs = target - Date.now();
    if (remainingMs <= 0) {
      // Target time reached while a fan has the page open — auto-hide
      // rather than showing a stuck 0:00:00 or an "available now" state.
      stopCountdown();
      return;
    }
    const totalSeconds = Math.floor(remainingMs / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const dayPart = days > 0 ? `${days}d ` : '';
    clockEl.textContent = `${dayPart}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  tick();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(tick, 1000);
}

async function loadSiteSettings() {
  try {
    const res = await fetch('/api/site-settings');
    const data = await res.json();

    const taglineEl = document.getElementById('site-tagline');
    if (taglineEl && data.tagline) taglineEl.textContent = data.tagline;

    if (data.countdown) {
      startCountdown(data.countdown.label, data.countdown.targetAt);
    } else {
      stopCountdown();
    }
  } catch (err) {
    // Non-critical — the storefront (catalog, checkout) works fine without
    // this, so a failure here shouldn't block or error out the page.
    console.error('[site-settings] failed to load:', err.message);
  }
}

// Builds either a big "featured" card (used once, for the newest release) or
// a normal grid card. Both open the same modal from the art, the title, or
// the buy button — the markup differs, the wiring doesn't.
function buildCard(project, isFeatured) {
  const releasedTracks = project.tracks.filter((t) => t.released);
  const priceLabel =
    project.pricingMode === 'fixed'
      ? money(project.fixedPriceCents)
      : `From ${money(project.pwywMinPerTrackCents * releasedTracks.length)}`;
  const trackCountLabel = `${releasedTracks.length} track${releasedTracks.length === 1 ? '' : 's'}`;
  const art = project.coverArtFile
    ? `<img src="/art/${project.coverArtFile}" alt="${project.title} cover art" />`
    : '<div class="art-placeholder"></div>';
  // Sold-out projects stay fully browsable (art, tracklist, previews all
  // still work via the modal) — only the ability to buy goes away. The
  // banner and grayscale treatment communicate that at a glance, and the
  // button text/click behavior still opens the modal so fans can look.
  const soldOutBanner = project.soldOut ? '<div class="sold-out-banner">Sold Out</div>' : '';
  const buyLabel = project.soldOut ? 'Sold Out · View Songs' : `${priceLabel} · View Songs &amp; Buy`;

  const card = document.createElement('div');

  if (isFeatured) {
    card.className = 'featured-card' + (project.soldOut ? ' is-sold-out' : '');
    card.innerHTML = `
      <div class="featured-art">${art}${soldOutBanner}</div>
      <div class="featured-body">
        <span class="featured-badge">Latest Release</span>
        <h2>${project.title}</h2>
        <p class="card-meta">${project.type} ${project.releaseYear ? '· ' + project.releaseYear : ''} · ${trackCountLabel}</p>
        <div class="card-actions">
          <button class="buy-button" data-project="${project.id}">${buyLabel}</button>
        </div>
      </div>
    `;
  } else {
    card.className = 'card' + (project.soldOut ? ' is-sold-out' : '');
    card.innerHTML = `
      <div class="card-art">${art}${soldOutBanner}</div>
      <div class="card-body">
        <h3>${project.title}</h3>
        <p class="card-meta">${project.type} ${project.releaseYear ? '· ' + project.releaseYear : ''} · ${trackCountLabel}</p>
        <div class="card-actions">
          <button class="buy-button" data-project="${project.id}">${buyLabel}</button>
        </div>
      </div>
    `;
  }

  const open = () => openModal(project);
  const artEl = card.querySelector(isFeatured ? '.featured-art' : '.card-art');
  const titleEl = card.querySelector(isFeatured ? 'h2' : 'h3');
  artEl.addEventListener('click', open);
  titleEl.addEventListener('click', open);
  card.querySelector('.buy-button').addEventListener('click', open);
  artEl.style.cursor = 'pointer';
  titleEl.style.cursor = 'pointer';
  return card;
}

// The catalog API already returns projects newest-first (by when Kyle added
// them), so projects[0] is always the latest release — that one gets the
// big featured treatment up top, everything else goes in the grid below.
function renderCatalog(projects) {
  if (!projects.length) {
    catalogEl.innerHTML = '<p class="loading">No releases yet — check back soon.</p>';
    return;
  }

  catalogEl.innerHTML = '';

  const [featured, ...rest] = projects;
  catalogEl.appendChild(buildCard(featured, true));

  if (rest.length) {
    const heading = document.createElement('h2');
    heading.className = 'section-heading';
    heading.textContent = 'More Releases';
    catalogEl.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const project of rest) {
      grid.appendChild(buildCard(project, false));
    }
    catalogEl.appendChild(grid);
  }
}

// Shared by both the modal track list and (eventually) any other preview
// button — only one clip plays at a time, and the button that started it
// flips back to "Preview" when something else starts or it finishes.
function togglePreviewButton(projectId, track, btn) {
  if (currentAudio && !currentAudio.paused && currentAudio.dataset.track === track.id) {
    currentAudio.pause();
    btn.textContent = '▶';
    return;
  }
  if (currentAudio) currentAudio.pause();
  if (currentPreviewButton) currentPreviewButton.textContent = '▶';

  currentAudio = new Audio(`/api/preview/${projectId}/${track.id}`);
  currentAudio.dataset.track = track.id;
  currentAudio.play();
  btn.textContent = '❚❚';
  currentPreviewButton = btn;
  currentAudio.addEventListener('ended', () => (btn.textContent = '▶'));
}

function renderModalTrackList(project) {
  const listEl = document.getElementById('modal-track-list');
  listEl.innerHTML = '';

  for (const track of project.tracks) {
    const row = document.createElement('div');
    row.className = 'track-row' + (track.released ? '' : ' track-row-locked');

    const canPreview = track.released && track.previewAudioFile;
    row.innerHTML = `
      <button class="track-play-btn" ${canPreview ? '' : 'disabled'}>${track.released ? '▶' : '🔒'}</button>
      <span class="track-row-title">${track.trackNumber}. ${track.title}${track.released ? '' : ' <em>(coming soon)</em>'}</span>
      <span class="track-row-duration">${formatDuration(track.durationSeconds)}</span>
    `;

    if (canPreview) {
      row.querySelector('.track-play-btn').addEventListener('click', (e) => {
        togglePreviewButton(project.id, track, e.currentTarget);
      });
    }

    listEl.appendChild(row);
  }
}

function openModal(project) {
  currentProject = project;
  modalError.classList.add('hidden');
  modalEmail.value = '';

  modalArt.src = project.coverArtFile ? `/art/${project.coverArtFile}` : '';
  modalArt.alt = `${project.title} cover art`;
  modalTitle.textContent = project.title;
  const releasedTracks = project.tracks.filter((t) => t.released);
  modalSubtitle.textContent = `${releasedTracks.length} track${releasedTracks.length === 1 ? '' : 's'}${
    project.tracks.length > releasedTracks.length ? ` · ${project.tracks.length - releasedTracks.length} unreleased (not included)` : ''
  }`;

  renderModalTrackList(project);

  if (project.pricingMode === 'fixed') {
    modalPriceFixed.classList.remove('hidden');
    modalPricePwyw.classList.add('hidden');
    modalFixedPrice.textContent = money(project.fixedPriceCents);
  } else {
    modalPriceFixed.classList.add('hidden');
    modalPricePwyw.classList.remove('hidden');
    const minCents = project.pwywMinPerTrackCents * releasedTracks.length;
    modalPwywNote.textContent = `Pay what you want — minimum ${money(minCents)} (${money(project.pwywMinPerTrackCents)}/track).`;
    modalAmountInput.value = (minCents / 100).toFixed(2);
    modalAmountInput.dataset.minCents = minCents;

    modalAmountButtons.innerHTML = '';
    const amounts = project.suggestedAmountsCents.length ? project.suggestedAmountsCents : [minCents];
    for (const amt of amounts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'amount-chip';
      b.textContent = money(amt);
      b.addEventListener('click', () => {
        modalAmountInput.value = (amt / 100).toFixed(2);
        document.querySelectorAll('.amount-chip').forEach((c) => c.classList.remove('selected'));
        b.classList.add('selected');
      });
      modalAmountButtons.appendChild(b);
    }
  }

  // Sold out: tracklist/preview above still work as normal (renderModalTrackList
  // already ran) — this just swaps the price + buy area for a plain notice and
  // hides the email field and pay button, so there's no way to start a checkout
  // for something that can't actually be fulfilled.
  const soldOutNotice = document.getElementById('modal-sold-out-notice');
  const emailLabel = document.querySelector('.email-label');
  const finePrint = document.querySelector('.fine-print');
  if (project.soldOut) {
    modalPriceFixed.classList.add('hidden');
    modalPricePwyw.classList.add('hidden');
    soldOutNotice.classList.remove('hidden');
    emailLabel.classList.add('hidden');
    modalPayButton.classList.add('hidden');
    finePrint.classList.add('hidden');
  } else {
    soldOutNotice.classList.add('hidden');
    emailLabel.classList.remove('hidden');
    modalPayButton.classList.remove('hidden');
    modalPayButton.disabled = false;
    modalPayButton.textContent = 'Continue to payment';
    finePrint.classList.remove('hidden');
  }

  modalBackdrop.classList.remove('hidden');
}

function closeModal() {
  modalBackdrop.classList.add('hidden');
  currentProject = null;
}

document.getElementById('modal-close').addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (e) => {
  if (e.target === modalBackdrop) closeModal();
});

modalPayButton.addEventListener('click', async () => {
  modalError.classList.add('hidden');

  if (currentProject.soldOut) return; // button is hidden for this case, but don't trust that alone

  const email = modalEmail.value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    modalError.textContent = 'Enter a valid email address.';
    modalError.classList.remove('hidden');
    return;
  }

  let amountCents;
  if (currentProject.pricingMode === 'pwyw') {
    amountCents = Math.round(parseFloat(modalAmountInput.value || '0') * 100);
    const minCents = parseInt(modalAmountInput.dataset.minCents, 10);
    if (!amountCents || amountCents < minCents) {
      modalError.textContent = `Minimum is ${money(minCents)}.`;
      modalError.classList.remove('hidden');
      return;
    }
  }

  modalPayButton.disabled = true;
  modalPayButton.textContent = 'Redirecting to secure checkout…';

  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: currentProject.id, email, amountCents }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout failed.');
    window.location.href = data.url;
  } catch (err) {
    modalError.textContent = err.message;
    modalError.classList.remove('hidden');
    modalPayButton.disabled = false;
    modalPayButton.textContent = 'Continue to payment';
  }
});

loadCatalog();
loadSiteSettings();
