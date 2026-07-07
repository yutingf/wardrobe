/* app.js — UI layer: fetch DC weather, run the engine, render outfits, and
   host the in-browser cataloging flow. Zero tokens: the only network calls
   are the free Open-Meteo API and the one-time CLIP model download. */

'use strict';

const LOCATION = { name: 'Washington, DC', lat: 38.9072, lon: -77.0369, tz: 'America/New_York' };
const HISTORY_KEY = 'wardrobe.history';

const WMO = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'], 51: ['Drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Drizzle', '🌧️'],
  61: ['Light rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'],
  67: ['Freezing rain', '🌧️'], 71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
  77: ['Snow', '🌨️'], 80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm', '⛈️'], 99: ['Thunderstorm', '⛈️'],
};

const CATEGORY_EMOJI = {
  tee: '👕', shirt: '👔', polo: '👕', sweater: '🧶', cardigan: '🧶', hoodie: '🧥',
  blazer: '🧥', coat: '🧥', jacket: '🧥', jeans: '👖', chinos: '👖', trousers: '👖',
  shorts: '🩳', skirt: '👗', dress: '👗', sneakers: '👟', shoes: '👞', boots: '🥾',
  scarf: '🧣', hat: '🧢',
};

const SWATCH_HEX = {
  black: '#1a1a1a', white: '#f5f5f2', gray: '#8a8a8a', grey: '#8a8a8a',
  'light gray': '#c9c9c9', charcoal: '#3d3d3d',
  silver: '#c0c0c0', cream: '#f0e9d8', ivory: '#f4efe1', beige: '#d9c7a7', tan: '#c8a06a',
  khaki: '#b7a878', stone: '#c9c2b2', taupe: '#8b7d6b', navy: '#1f2f52', denim: '#4a6a94',
  indigo: '#2a3a6b', brown: '#6b4a2f', camel: '#b3854d', chocolate: '#4e342e', cognac: '#9a5b2f',
  rust: '#b7410e', terracotta: '#c96f4a', burgundy: '#6d2033', maroon: '#5c1f2e', wine: '#722f37',
  olive: '#6b6b3f', forest: '#2f4f33', sage: '#9caf88', mustard: '#d4a017', red: '#c0392b',
  coral: '#ee6f57', salmon: '#f28a7b', orange: '#e07b39', peach: '#f2b28c', yellow: '#e8c33b',
  gold: '#c9a227', lime: '#9acd32', green: '#3e7c4f', mint: '#a8d5ba', teal: '#2f7f7f',
  turquoise: '#40c4c4', 'light blue': '#a3c6e8', 'sky blue': '#8fc1e8', 'baby blue': '#b5d3ec',
  blue: '#3b6fb5', 'royal blue': '#2b4dbb', cobalt: '#2b52a8', purple: '#6a4c93',
  violet: '#7a5ba6', lavender: '#b9a7d6', magenta: '#b03a8c', fuchsia: '#c73a9e',
  pink: '#e29ab0', blush: '#e8c2c8', rose: '#d98a9e',
};

// ------------------------------------------------------------------ weather

async function fetchWeather() {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${LOCATION.lat}&longitude=${LOCATION.lon}`
    + '&hourly=apparent_temperature,temperature_2m,precipitation_probability,wind_speed_10m,weather_code'
    + `&timezone=${encodeURIComponent(LOCATION.tz)}&forecast_days=1`
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`weather API returned ${res.status}`);
  const data = await res.json();
  const h = data.hourly;
  const at = i => h.apparent_temperature[i];
  const slice = (from, to, arr) => arr.slice(from, to + 1);
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    feelsMorning: avg([at(7), at(8), at(9)]),
    feelsPeak: Math.max(...slice(11, 17, h.apparent_temperature)),
    tempNow: h.temperature_2m[new Date().getHours()],
    feelsNow: at(new Date().getHours()),
    rainProb: Math.max(...slice(7, 22, h.precipitation_probability)),
    windMax: Math.max(...slice(7, 22, h.wind_speed_10m)),
    code: h.weather_code[13],
  };
}

// ------------------------------------------------------------------ closet (samples + user items)

let userItems = []; // from IndexedDB, with _photoUrls object URLs attached

async function loadUserItems() {
  const items = await DBX.getAllItems();
  for (const it of items) {
    it._photoUrls = [];
    for (const key of it.photoKeys || []) {
      const blob = await DBX.getPhoto(key);
      if (blob) it._photoUrls.push(URL.createObjectURL(blob));
    }
  }
  userItems = items;
}

// Sample items stand in only until the real closet covers their layer.
function mergedCatalog() {
  const coveredLayers = new Set(userItems.map(it => it.layer));
  const samples = CATALOG.filter(it => !(it.sample && coveredLayers.has(it.layer)));
  return [...userItems, ...samples];
}

// ------------------------------------------------------------------ history (variety)

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}

function recentWearMap() {
  const today = new Date();
  const map = {};
  for (const entry of loadHistory()) {
    const days = Math.round((today - new Date(entry.date + 'T12:00')) / 86400000);
    if (days >= 1 && days <= 3) for (const id of entry.ids) if (!(id in map) || map[id] > days) map[id] = days;
  }
  return map;
}

// The first top pick shown each day counts as "worn" for tomorrow's variety.
function autoLogTopPick(outfit) {
  const date = new Date().toISOString().slice(0, 10);
  const history = loadHistory();
  if (history.some(e => e.date === date)) return;
  history.push({ date, ids: outfit.items.map(it => it.id) });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-14)));
}

// ------------------------------------------------------------------ rendering

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function activateTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#today-view').hidden = tab !== 'today';
  $('#closet-view').hidden = tab !== 'closet';
  $('#add-view').hidden = tab !== 'add';
}

function photoUrl(it) {
  if (it._photoUrls && it._photoUrls.length) return it._photoUrls[0];
  if (it.photos && it.photos.length) return `../closet/photos/${it.photos[0]}`;
  return null;
}

function itemCard(it, slotLabel, extraHTML = '') {
  const url = photoUrl(it);
  const visual = url
    ? `<img class="item-photo" src="${esc(url)}" alt="${esc(it.name)}">`
    : `<div class="item-swatch" style="background:${SWATCH_HEX[(it.colors || [])[0]] || '#999'}">
         <span>${CATEGORY_EMOJI[it.category] || '🧺'}</span></div>`;
  return `<div class="item-card">
    ${visual}
    <div class="item-meta">
      <div class="item-slot">${esc(slotLabel)}</div>
      <div class="item-name">${esc(it.name)}</div>
      <div class="item-tags">${esc(it.material || '')}${it.pattern && it.pattern !== 'solid' ? ' · ' + esc(it.pattern) : ''}</div>
      ${extraHTML}
    </div>
  </div>`;
}

function outfitHTML(outfit, rank) {
  const s = outfit.slots;
  const rows = [
    s.outer && itemCard(s.outer, 'Outer layer'),
    s.mid && itemCard(s.mid, 'Mid layer'),
    itemCard(s.base, 'Base'),
    itemCard(s.bottom, 'Bottom'),
    itemCard(s.footwear, 'Footwear'),
    ...(outfit.accessories || []).map(a => itemCard(a, 'Accessory')),
  ].filter(Boolean).join('');
  const reasons = outfit.reasons.slice(0, 4).map(r => `<li>${esc(r)}</li>`).join('');
  const warnings = outfit.warnings.slice(0, 2).map(w => `<li class="warn">${esc(w)}</li>`).join('');
  return `<div class="outfit ${rank === 0 ? 'primary' : ''}">
    <h3>${rank === 0 ? "Today's pick" : `Alternative ${rank}`}</h3>
    <div class="outfit-items">${rows}</div>
    ${reasons || warnings ? `<ul class="why">${reasons}${warnings}</ul>` : ''}
  </div>`;
}

function renderWeather(wx) {
  const [label, icon] = WMO[wx.code] || ['…', '🌡️'];
  $('#weather').innerHTML = `
    <div class="wx-icon">${icon}</div>
    <div class="wx-main">
      <div class="wx-temp">${Math.round(wx.feelsNow)}°F <span class="wx-label">feels like now · ${esc(label)}</span></div>
      <div class="wx-detail">morning ${Math.round(wx.feelsMorning)}° · afternoon peak ${Math.round(wx.feelsPeak)}°
        · rain ${Math.round(wx.rainProb)}% · wind ${Math.round(wx.windMax)} mph</div>
      <div class="wx-detail">${esc(LOCATION.name)} · ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
    </div>`;
}

function renderOutfits(result) {
  const el = $('#outfits');
  if (result.missing) {
    el.innerHTML = `<p class="empty">The closet has no ${esc(result.missing.join(', '))} suitable for this
      occasion yet. Use the Add clothes tab to upload photos.</p>`;
    return;
  }
  const notes = result.plan.notes.map(n => `<div class="plan-note">💡 ${esc(n)}</div>`).join('');
  el.innerHTML = notes + result.outfits.map((o, i) => outfitHTML(o, i)).join('');
  if (result.outfits.length) autoLogTopPick(result.outfits[0]);
}

function renderCloset() {
  const groups = { base: 'Tops (base)', mid: 'Mid layers', outer: 'Outer layers', bottom: 'Bottoms', footwear: 'Footwear', accessory: 'Accessories' };
  const catalog = mergedCatalog();
  $('#closet').innerHTML = Object.entries(groups).map(([layer, title]) => {
    const items = catalog.filter(it => it.layer === layer);
    if (!items.length) return '';
    return `<h3>${title} <span class="count">${items.length}</span></h3>
      <div class="closet-grid">${items.map(it => itemCard(
        it,
        it.sample ? 'sample' : `formality ${it.formality} · warmth ${it.warmth}`,
        it.user ? `<button class="mini-btn del-btn" data-id="${esc(it.id)}">Remove</button>` : ''
      )).join('')}</div>`;
  }).join('');
  $('#closet').querySelectorAll('.del-btn').forEach(btn => btn.addEventListener('click', async () => {
    const item = userItems.find(it => it.id === btn.dataset.id);
    if (!item || !confirm(`Remove "${item.name}" from the closet?`)) return;
    await DBX.deletePhotos(item.photoKeys || []);
    await DBX.deleteItem(item.id);
    await refresh();
  }));
}

// ------------------------------------------------------------------ add-clothes flow

let pendingDrafts = [];

function draftCardHTML(draft, di) {
  const conf = k => `${Math.round(draft.confidence[k] * 100)}%`;
  const catOpts = [...new Set(CATALOGER.CATEGORY_LABELS.map(c => c.category))]
    .map(c => `<option value="${c}" ${c === draft.category ? 'selected' : ''}>${c}</option>`).join('');
  const colorOpts = CATALOGER.COLOR_NAMES
    .map(c => `<option value="${c}" ${c === draft.color ? 'selected' : ''}>${c}</option>`).join('');
  const patOpts = CATALOGER.PATTERN_LABELS
    .map(p => `<option value="${p.value}" ${p.value === draft.pattern ? 'selected' : ''}>${p.value}</option>`).join('');
  const matOpts = CATALOGER.MATERIAL_LABELS
    .map(x => `<option value="${x}" ${x === draft.material ? 'selected' : ''}>${x}</option>`).join('');
  const mergeOpts = ['<option value="">— save as new item —</option>',
    ...userItems.map(it => `<option value="${esc(it.id)}">add photos to: ${esc(it.name)}</option>`)].join('');
  const photos = draft.photos.map(p => `<img class="draft-photo" src="${p.url}" alt="">`).join('');
  const labelBadge = draft.fromLabel
    ? `<div class="label-badge">✓ Read from the product label — color, category and material taken from the listing text.</div>`
    : '';
  const angleAsk = draft.needsMoreAngles
    ? `<div class="angle-ask">Low confidence. Add 1-2 more angles: a straight-on flat
        shot, plus a close-up of the fabric.
        <button class="mini-btn add-angle-btn" data-di="${di}">📷 Add angles</button></div>`
    : '';
  return `<div class="card draft" data-di="${di}">
    <div class="draft-head">
      <span class="draft-num">Garment ${di + 1}</span>
      <button class="mini-btn skip-btn" data-di="${di}">Skip / not mine</button>
    </div>
    <div class="draft-photos">${photos}</div>
    ${labelBadge}${angleAsk}
    <div class="draft-fields">
      <label>Name <input type="text" data-f="name" value="${esc(draft.name)}"></label>
      <label>Category (${conf('category')}) <select data-f="category">${catOpts}</select></label>
      <label>Color (from the garment's pixels) <select data-f="color">${colorOpts}</select></label>
      <label>Pattern (${conf('pattern')}) <select data-f="pattern">${patOpts}</select></label>
      <label>Material (${conf('material')}) <select data-f="material">${matOpts}</select></label>
      <label>Warmth <input type="number" data-f="warmth" min="1" max="5" step="0.5" value="${draft.warmth}"></label>
      <label>Formality <input type="number" data-f="formality" min="1" max="5" step="0.5" value="${draft.formality}"></label>
      <label>Existing piece? <select data-f="mergeInto">${mergeOpts}</select></label>
    </div>
  </div>`;
}

const CATEGORY_TO_LAYER = {};
function buildCategoryLayerMap() {
  for (const c of CATALOGER.CATEGORY_LABELS) CATEGORY_TO_LAYER[c.category] = c.layer;
}

let angleTargetDraft = null;

function renderDrafts() {
  const el = $('#review');
  if (!pendingDrafts.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<p class="hint">Found <strong>${pendingDrafts.length}</strong> garment(s) in the photos
      (multiple pieces in one photo get separated automatically).
      Check the guesses below, fix anything wrong, then save.</p>`
    + pendingDrafts.map((d, i) => draftCardHTML(d, i)).join('')
    + `<button id="save-drafts" class="primary-btn">Save all to closet</button>`;
  $('#save-drafts').addEventListener('click', saveDrafts);
  el.querySelectorAll('.add-angle-btn').forEach(btn => btn.addEventListener('click', () => {
    readDraftEdits(); // keep any manual fixes before re-drafting
    angleTargetDraft = pendingDrafts[Number(btn.dataset.di)];
    $('#angle-input').click();
  }));
  el.querySelectorAll('.skip-btn').forEach(btn => btn.addEventListener('click', () => {
    readDraftEdits(); // preserve edits on the other cards before re-indexing
    pendingDrafts.splice(Number(btn.dataset.di), 1);
    renderDrafts();
  }));
}

async function handleAngleFiles(files) {
  if (!angleTargetDraft || !files.length) return;
  const status = $('#cat-status');
  const draft = angleTargetDraft;
  angleTargetDraft = null;
  const editedName = draft.name;
  const onProgress = msg => { status.textContent = msg; };
  try {
    const draftMeta = {
      categoryPrior: draft.photos[0] ? draft.photos[0].categoryPrior : null,
      photos: draft.photos.map(p => ({ embed: p.embed, colors: p.colors, areaFrac: p.areaFrac, sourceIndex: p.sourceIndex, categoryPrior: p.categoryPrior })),
    };
    try {
      const res = await runInWorker({ cmd: 'angles', files: [...files], draftMeta }, onProgress);
      draft.photos.push(...attachUrls(res.fresh));
      Object.assign(draft, res.attrs);
    } catch (workerErr) {
      console.warn('analysis worker unavailable, running on the main thread:', workerErr);
      await CATALOGER.addAnglesToDraft(draft, [...files], onProgress);
    }
    draft.name = editedName; // attribute re-draft must not clobber a typed name
    renderDrafts();
    status.textContent = '';
  } catch (err) {
    status.textContent = `Could not analyze the extra angles: ${(err && err.message) ? err.message : String(err)}`;
  }
}

function readDraftEdits() {
  document.querySelectorAll('.draft').forEach(card => {
    const d = pendingDrafts[Number(card.dataset.di)];
    card.querySelectorAll('[data-f]').forEach(input => {
      const f = input.dataset.f;
      d[f] = (f === 'warmth' || f === 'formality') ? Number(input.value) : input.value;
    });
    d.layer = CATEGORY_TO_LAYER[d.category] || d.layer;
  });
}

async function saveDrafts() {
  readDraftEdits();
  for (const d of pendingDrafts) {
    if (d.mergeInto) {
      const target = userItems.find(it => it.id === d.mergeInto);
      if (target) { await CATALOGER.addPhotosToItem(target, d.photos); continue; }
    }
    await CATALOGER.saveItem(d);
  }
  const n = pendingDrafts.length;
  pendingDrafts = [];
  await clearStagingDB();
  renderDrafts();
  await refresh();
  $('#cat-status').textContent = `Saved ${n} garment(s) to the closet ✓`;
}

// Photos accumulate in a staging strip (from the camera one at a time, or the
// picker in bulk), then one Analyze pass groups and classifies the whole batch.
// Each staged photo is ALSO persisted to IndexedDB immediately: phones evict
// the page while the camera app is open (and can crash it during analysis),
// and persisted staging means nothing is lost — shots reappear after reload.
let stagedPhotos = []; // { file, url, key }
let stagingSeq = 0;

function renderStaging() {
  const el = $('#staging');
  el.innerHTML = stagedPhotos.map((p, i) =>
    `<div class="staged"><img src="${p.url}" alt="staged photo"><button class="unstage" data-i="${i}">✕</button></div>`).join('');
  el.querySelectorAll('.unstage').forEach(b => b.addEventListener('click', async () => {
    const i = Number(b.dataset.i);
    URL.revokeObjectURL(stagedPhotos[i].url);
    await DBX.deletePhotos([stagedPhotos[i].key]);
    stagedPhotos.splice(i, 1);
    renderStaging();
  }));
  const btn = $('#analyze-btn');
  btn.hidden = stagedPhotos.length === 0;
  btn.textContent = `Analyze ${stagedPhotos.length} photo${stagedPhotos.length === 1 ? '' : 's'}`;
}

// source is encoded in the key ('camera' | 'paste' | 'upload') so it survives
// a reload; camera shots skip the OCR text-reading pass during analysis.
async function stageFiles(files, source = 'upload') {
  for (const f of files) {
    const key = `staging-${source}-${Date.now()}-${stagingSeq++}`;
    await DBX.putPhoto(key, f);
    stagedPhotos.push({ file: f, url: URL.createObjectURL(f), key, source });
  }
  renderStaging();
}

async function restoreStaging() {
  const rec = await DBX.listPhotos('staging-');
  for (const r of rec) {
    const src = ['camera', 'paste', 'upload'].includes(r.key.split('-')[1]) ? r.key.split('-')[1] : 'upload';
    stagedPhotos.push({ file: r.blob, url: URL.createObjectURL(r.blob), key: r.key, source: src });
  }
  if (stagedPhotos.length) renderStaging();
}

async function clearStagingDB() {
  await DBX.deletePhotos((await DBX.listPhotos('staging-')).map(r => r.key));
}

// ------------------------------------------------------------------ in-page camera

// The camera runs INSIDE the page (getUserMedia viewfinder + shutter). The
// system-camera file input is only a fallback: switching to the camera app
// makes iOS evict this page, and the returned photo is delivered to a page
// that no longer exists — the shot is lost before it can be staged.
let cameraStream = null;

async function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('#camera-input').click();
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1920 } },
      audio: false,
    });
  } catch {
    $('#camera-input').click(); // permission denied: fall back to the system camera
    return;
  }
  $('#camera-video').srcObject = cameraStream;
  $('#camera-count').textContent = stagedPhotos.length ? `${stagedPhotos.length} staged` : '';
  $('#camera-modal').hidden = false;
}

function closeCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  $('#camera-video').srcObject = null;
  $('#camera-modal').hidden = true;
}

async function captureFrame() {
  const video = $('#camera-video');
  if (!video.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  await stageFiles([new File([blob], `shot-${Date.now()}.jpg`, { type: 'image/jpeg' })], 'camera');
  $('#camera-count').textContent = `${stagedPhotos.length} staged`;
}

// ------------------------------------------------------------------ paste

async function pasteImages() {
  const status = $('#cat-status');
  try {
    const items = await navigator.clipboard.read();
    const files = [];
    for (const item of items) {
      const type = item.types.find(t => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      files.push(new File([blob], `pasted-${Date.now()}.${type.split('/')[1] || 'png'}`, { type }));
    }
    if (!files.length) { status.textContent = 'No image on the clipboard.'; return; }
    await stageFiles(files, 'paste');
    status.textContent = '';
  } catch (err) {
    status.textContent = `Could not read the clipboard (${err.message}). Copy an image and try Ctrl/Cmd+V instead.`;
  }
}

// Ctrl/Cmd+V works anywhere in the app, not just on the Add tab
document.addEventListener('paste', e => {
  const files = [...((e.clipboardData && e.clipboardData.items) || [])]
    .filter(it => it.type.startsWith('image/'))
    .map(it => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  activateTab('add');
  stageFiles(files, 'paste');
});

// ------------------------------------------------------------------ analysis worker

// Heavy vision work runs in a FRESH worker per analysis, terminated when it
// settles: terminating a worker is the only way its wasm memory actually
// returns to the OS, which keeps the tab light after results (phone tabs
// get killed otherwise). Falls back to running on the main thread.
function runInWorker(payload, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker('analysis-worker.js?v=17', { type: 'module' }); }
    catch (err) { reject(err); return; }
    const id = Math.random().toString(36).slice(2);
    const done = fn => arg => { worker.terminate(); fn(arg); };
    const ok = done(resolve), fail = done(reject);
    worker.onerror = e => fail(new Error(e.message || 'analysis worker failed to start'));
    worker.onmessage = e => {
      if (e.data.id !== id) return;
      if (e.data.type === 'progress') onProgress(e.data.msg);
      else if (e.data.type === 'result') ok(e.data);
      else fail(new Error(e.data.message));
    };
    worker.postMessage({ id, ...payload });
  });
}

function attachUrls(photos) {
  for (const p of photos) if (!p.url && p.blob) p.url = URL.createObjectURL(p.blob);
  return photos;
}

// Crash forensics: the current analysis stage is checkpointed to
// localStorage. If the tab gets killed mid-analysis (phone OOM), the next
// load finds the marker and reports exactly where it died.
const CRASH_KEY = 'wardrobe.analysis';

function crashMark(stage) {
  try { localStorage.setItem(CRASH_KEY, JSON.stringify({ stage, at: new Date().toISOString(), photos: stagedPhotos.length })); } catch { /* private mode */ }
}
function crashClear() { try { localStorage.removeItem(CRASH_KEY); } catch { /* private mode */ } }
function crashReport() {
  try { return JSON.parse(localStorage.getItem(CRASH_KEY)); } catch { return null; }
}

async function analyzeStaged() {
  if (!stagedPhotos.length) return;
  const status = $('#cat-status');
  const btn = $('#analyze-btn');
  btn.disabled = true;
  crashMark('starting');
  try {
    const ocrFlags = stagedPhotos.map(p => p.source !== 'camera');
    const files = stagedPhotos.map(p => p.file);
    const onProgress = msg => { status.textContent = msg; if (msg) crashMark(msg); };
    // OCR runs here (its own worker, terminated after); vision runs in the
    // analysis worker so its memory is returned when the worker terminates
    const hints = await CATALOGER.readHints(files, ocrFlags, onProgress);
    let drafts;
    try {
      const res = await runInWorker({ cmd: 'draft', files, hints }, onProgress);
      drafts = res.drafts.list;
      drafts.ocr = res.drafts.ocr;
      for (const d of drafts) attachUrls(d.photos);
    } catch (workerErr) {
      console.warn('analysis worker unavailable, running on the main thread:', workerErr);
      crashMark('starting (main thread)');
      drafts = await CATALOGER.draftGroupsCore(files, hints, onProgress);
    }
    for (const d of drafts) d.name = `${d.color} ${d.category}`.replace(/^./, c => c.toUpperCase());
    // tell the user when a pasted image had no readable text
    const unread = (drafts.ocr ? drafts.ocr.attempted.filter(i => !drafts.ocr.found.includes(i)) : []);
    pendingDrafts = drafts;
    stagedPhotos.forEach(p => URL.revokeObjectURL(p.url));
    stagedPhotos = [];
    // staging stays in IndexedDB until the drafts are SAVED, so a crash
    // during review still leaves the shots recoverable on reload
    renderStaging();
    renderDrafts();
    status.textContent = unread.length
      ? `No readable product text on ${unread.length} image(s); those used vision only — check their fields.`
      : '';
    crashClear();
  } catch (err) {
    const stage = (crashReport() || {}).stage || 'starting';
    const detail = (err && err.message) ? err.message : String(err);
    status.textContent = `Analysis failed at "${stage}": ${detail}. `
      + `Your photos are still staged; tap Analyze to retry (a different engine is tried automatically).`;
    console.error('analysis failed at', stage, err);
    crashClear(); // handled: not a tab crash
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ export / import

function exportCatalog() {
  const data = userItems.map(({ _photoUrls, photoKeys, ...it }) => it);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'wardrobe-catalog.json';
  a.click();
}

async function importCatalog(file) {
  const items = JSON.parse(await file.text());
  for (const it of items) if (it.id && it.layer) await DBX.putItem({ ...it, user: true });
  await refresh();
}

// ------------------------------------------------------------------ main

let currentWx = null;
let currentOccasion = 'work';

function rerun() {
  if (!currentWx) return;
  renderOutfits(ENGINE.generateOutfits(mergedCatalog(), currentWx, currentOccasion, recentWearMap()));
}

async function refresh() {
  await loadUserItems();
  renderCloset();
  $('#sample-banner').hidden = !mergedCatalog().some(it => it.sample);
  rerun();
}

async function main() {
  buildCategoryLayerMap();

  document.querySelectorAll('.occ-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.occ-btn').forEach(b => b.classList.toggle('active', b === btn));
    currentOccasion = btn.dataset.occasion;
    rerun();
  }));

  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));

  $('#upload-btn').addEventListener('click', () => $('#photo-input').click());
  $('#paste-btn').addEventListener('click', pasteImages);
  $('#camera-btn').addEventListener('click', openCamera);
  $('#camera-shutter').addEventListener('click', captureFrame);
  $('#camera-close').addEventListener('click', closeCamera);
  $('#photo-input').addEventListener('change', e => { stageFiles([...e.target.files], 'upload'); e.target.value = ''; });
  $('#camera-input').addEventListener('change', e => { stageFiles([...e.target.files], 'camera'); e.target.value = ''; });
  $('#analyze-btn').addEventListener('click', analyzeStaged);
  $('#angle-input').addEventListener('change', e => {
    handleAngleFiles([...e.target.files]);
    e.target.value = '';
  });
  $('#export-btn').addEventListener('click', exportCatalog);
  $('#import-btn').addEventListener('click', () => $('#import-input').click());
  $('#import-input').addEventListener('change', e => e.target.files[0] && importCatalog(e.target.files[0]));

  await loadUserItems();
  renderCloset();
  await restoreStaging();
  const crash = crashReport();
  if (crash) {
    crashClear();
    activateTab('add');
    $('#cat-status').textContent = `Last analysis did not finish; the browser stopped it at "${crash.stage}". `
      + `Your photos are still staged below. Try again with fewer photos at once, or close other tabs first.`;
  } else if (stagedPhotos.length) {
    // photos recovered from a previous session: land the user right on them
    activateTab('add');
    $('#cat-status').textContent = `Restored ${stagedPhotos.length} photo${stagedPhotos.length === 1 ? '' : 's'} from your last session.`;
  }
  $('#sample-banner').hidden = !mergedCatalog().some(it => it.sample);

  try {
    currentWx = await fetchWeather();
    renderWeather(currentWx);
    rerun();
  } catch (err) {
    $('#weather').innerHTML = `<p class="empty">Could not load weather (${esc(err.message)}). Check the internet connection and reload.</p>`;
  }
}

main();
