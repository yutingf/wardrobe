/* app.js — UI layer: fetch DC weather, run the engine, render outfits.
   Zero tokens: the only network call is to the free Open-Meteo API. */

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
  black: '#1a1a1a', white: '#f5f5f2', gray: '#8a8a8a', grey: '#8a8a8a', charcoal: '#3d3d3d',
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

function recordWear(items) {
  const date = new Date().toISOString().slice(0, 10);
  const history = loadHistory().filter(e => e.date !== date).slice(-13);
  history.push({ date, ids: items.map(it => it.id) });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

// ------------------------------------------------------------------ rendering

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function itemCard(it, slotLabel) {
  const photo = it.photos && it.photos[0];
  const visual = photo
    ? `<img class="item-photo" src="../closet/photos/${esc(photo)}" alt="${esc(it.name)}">`
    : `<div class="item-swatch" style="background:${SWATCH_HEX[(it.colors || [])[0]] || '#999'}">
         <span>${CATEGORY_EMOJI[it.category] || '🧺'}</span></div>`;
  return `<div class="item-card">
    ${visual}
    <div class="item-meta">
      <div class="item-slot">${esc(slotLabel)}</div>
      <div class="item-name">${esc(it.name)}</div>
      <div class="item-tags">${esc(it.material || '')}${it.pattern && it.pattern !== 'solid' ? ' · ' + esc(it.pattern) : ''}</div>
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
    <div class="outfit-header">
      <h3>${rank === 0 ? "Today's pick" : `Alternative ${rank}`}</h3>
      <button class="wear-btn" data-rank="${rank}">I'm wearing this</button>
    </div>
    <div class="outfit-items">${rows}</div>
    ${reasons || warnings ? `<ul class="why">${reasons}${warnings}</ul>` : ''}
  </div>`;
}

function renderWeather(wx) {
  const [label, icon] = WMO[wx.code] || ['—', '🌡️'];
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
      occasion yet. Add photos to <code>closet/photos/</code> and ask Claude to catalog them.</p>`;
    return;
  }
  const notes = result.plan.notes.map(n => `<div class="plan-note">💡 ${esc(n)}</div>`).join('');
  el.innerHTML = notes + result.outfits.map((o, i) => outfitHTML(o, i)).join('');
  el.querySelectorAll('.wear-btn').forEach(btn => btn.addEventListener('click', () => {
    const o = result.outfits[Number(btn.dataset.rank)];
    recordWear(o.items);
    btn.textContent = 'Logged ✓ (helps tomorrow’s variety)';
    btn.disabled = true;
  }));
}

function renderCloset() {
  const groups = { base: 'Tops (base)', mid: 'Mid layers', outer: 'Outer layers', bottom: 'Bottoms', footwear: 'Footwear', accessory: 'Accessories' };
  $('#closet').innerHTML = Object.entries(groups).map(([layer, title]) => {
    const items = CATALOG.filter(it => it.layer === layer);
    if (!items.length) return '';
    return `<h3>${title} <span class="count">${items.length}</span></h3>
      <div class="closet-grid">${items.map(it => itemCard(it, `formality ${it.formality} · warmth ${it.warmth}`)).join('')}</div>`;
  }).join('');
}

// ------------------------------------------------------------------ main

let currentWx = null;
let currentOccasion = 'work';

function rerun() {
  if (!currentWx) return;
  renderOutfits(ENGINE.generateOutfits(CATALOG, currentWx, currentOccasion, recentWearMap()));
}

async function main() {
  if (CATALOG.some(it => it.sample)) $('#sample-banner').hidden = false;

  document.querySelectorAll('.occ-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.occ-btn').forEach(b => b.classList.toggle('active', b === btn));
    currentOccasion = btn.dataset.occasion;
    rerun();
  }));

  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    $('#today-view').hidden = btn.dataset.tab !== 'today';
    $('#closet-view').hidden = btn.dataset.tab !== 'closet';
  }));

  renderCloset();

  try {
    currentWx = await fetchWeather();
    renderWeather(currentWx);
    rerun();
  } catch (err) {
    $('#weather').innerHTML = `<p class="empty">Could not load weather (${esc(err.message)}). Check the internet connection and reload.</p>`;
  }
}

main();
