/* Reisebegleiter – persönliche Reise-Assistenz (PWA)
 * Datenquellen:
 *   - Transitous / MOTIS (api.transitous.org): deutschlandweit DB-Fern- & Regionalverkehr + ÖPNV inkl. Echtzeit
 *   - OpenStreetMap Nominatim: Adresssuche (Fallback)
 *   - HERE Routing (optional, eigener Schlüssel): Auto-Fahrzeit mit Verkehrslage
 *   - Claude API (optional, eigener Schlüssel): E-Mails/Screenshots verstehen, Fragen beantworten
 * Alle Daten bleiben lokal auf dem Gerät (localStorage).
 */
'use strict';

/* ───────────── Grundlagen ───────────── */
const API = 'https://api.transitous.org/api';
const TZ = 'Europe/Berlin';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STORE_KEY = 'reisebegleiter.v1';
const DEFAULTS = {
  events: [],
  active: null,
  feed: [],
  feedback: [],
  favorites: [],
  opens: 0,
  settings: {
    claudeKey: '', claudeModel: 'claude-haiku-5-5', hereKey: '',
    transferMin: 5, delayThreshold: 3, alightLead: 5, notify: true, voice: false, wakeLock: true,
    refreshSec: 60, theme: 'auto',
    interveneDelay: 20, minGain: 10, transferPenalty: 10
  }
};
let S = load();
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!raw) return structuredClone(DEFAULTS);
    return { ...structuredClone(DEFAULTS), ...raw, settings: { ...DEFAULTS.settings, ...(raw.settings || {}) } };
  } catch { return structuredClone(DEFAULTS); }
}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { console.warn(e); } }

const fmtT = iso => iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '–';
const fmtD = iso => new Date(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TZ });
const dayKey = iso => new Date(iso).toLocaleDateString('sv-SE', { timeZone: TZ });
const mins = ms => Math.round(ms / 60000);
const delayOf = (rt, sched) => (rt && sched) ? mins(new Date(rt) - new Date(sched)) : 0;
const fmtDur = sec => { const m = Math.round(sec / 60); return m < 60 ? `${m} Min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
function haversine(a, b) {
  const R = 6371e3, t = x => x * Math.PI / 180;
  const dLat = t(b.lat - a.lat), dLon = t(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtKm = m => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function localInputValue(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ───────────── API-Zugriffe ───────────── */
async function getJSON(url, opts = {}, timeout = 20000) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(to); }
}
const qs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const placeParam = p => p.stopId || `${p.lat},${p.lon}`;

/* Ortssuche in Stufen: gemerkte Orte → Google (optional, eigener Schlüssel) → Fahrplan-Halte → Photon (POIs, nach
 * Reise-Ort gewichtet) → Nominatim. Ergebnisse nahe der aktuellen/nächsten Reise kommen zuerst. */
const normKey = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function geoContext() {
  const ev = activeEvent() || nextEvent();
  if (ev?.place?.lat) return { lat: ev.place.lat, lon: ev.place.lon, city: cityOf(ev) };
  return GPS.pos ? { lat: GPS.pos.lat, lon: GPS.pos.lon } : null;
}
async function geocode(text, ctx = geoContext()) {
  let out = [];
  const q = normKey(text);
  // 1) gemerkte Orte (z. B. „KOM27“ → Mauerstraße 27)
  for (const [k, p] of Object.entries(S.placeAliases || {})) if (q && (k.includes(q) || q.includes(k))) out.push({ ...p, type: p.type || 'PLACE', known: true });
  // 2) Google Places – nur mit eigenem Schlüssel
  if (S.settings.googleKey) {
    try {
      const r = await getJSON('https://places.googleapis.com/v1/places:searchText', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': S.settings.googleKey, 'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location' }, body: JSON.stringify({ textQuery: text, languageCode: 'de', ...(ctx ? { locationBias: { circle: { center: { latitude: ctx.lat, longitude: ctx.lon }, radius: 50000 } } } : {}) }) });
      for (const p of (r.places || []).slice(0, 5)) out.push({ name: p.displayName?.text, address: p.formattedAddress, lat: p.location.latitude, lon: p.location.longitude, type: 'PLACE', src: 'Google' });
    } catch (e) { console.warn('google', e); }
  }
  // 3) Photon: findet Firmen, Veranstaltungsorte, Hotels; Ergebnisse nahe der Reise bevorzugt
  try {
    const r = await getJSON(`https://photon.komoot.io/api/?${qs({ q: text, limit: 6, lang: 'de', lat: ctx?.lat, lon: ctx?.lon })}`);
    for (const f of r.features || []) {
      const p = f.properties, [lon, lat] = f.geometry.coordinates;
      const street = [p.street, p.housenumber].filter(Boolean).join(' ');
      out.push({ name: p.name || street || p.city, lat, lon, type: p.osm_key === 'tourism' && p.osm_value === 'hotel' ? 'HOTEL' : 'PLACE', address: [street, [p.postcode, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') });
    }
  } catch (e) { console.warn('photon', e); }
  try {
    const r = await getJSON(`${API}/v1/geocode?${qs({ text, language: 'de' })}`);
    for (const x of r.slice(0, 7)) {
      const area = (x.areas || []).find(a => a.default)?.name || '';
      out.push({ name: x.name, lat: x.lat, lon: x.lon, type: x.type, stopId: x.type === 'STOP' ? x.id : undefined, address: [x.street, x.houseNumber].filter(Boolean).join(' ') + (area ? (x.street ? ', ' : '') + area : '') });
    }
  } catch (e) { console.warn('geocode', e); }
  if (out.filter(o => o.type !== 'STOP').length < 2) {
    try {
      const r = await getJSON(`https://nominatim.openstreetmap.org/search?${qs({ q: text, format: 'json', limit: 5, 'accept-language': 'de', countrycodes: 'de,at,ch,nl,be,fr,dk,pl,cz,it,lu' })}`);
      for (const x of r) out.push({ name: x.name || x.display_name.split(',')[0], lat: +x.lat, lon: +x.lon, type: x.type === 'hotel' ? 'HOTEL' : 'PLACE', address: x.display_name.split(',').slice(1, 4).join(',').trim() });
    } catch (e) { console.warn('nominatim', e); }
  }
  // Dubletten raus; Treffer weit weg von der aktuellen Reise (> 300 km) nach hinten; Haltestellen nur, wenn der Name passt
  const seen = new Set();
  out = out.filter(o => o.lat && o.name && !seen.has(`${o.name}|${o.lat.toFixed(3)}`) && seen.add(`${o.name}|${o.lat.toFixed(3)}`));
  const words = q.split(' ').filter(w => w.length > 2);
  const score = (o, i) => i + (o.known ? -100 : 0) + (ctx && haversine(ctx, o) > 300000 ? 50 : 0) + (o.type === 'STOP' && words.length && !words.every(w => normKey(o.name).includes(w)) ? 30 : 0);
  return out.map((o, i) => [o, score(o, i)]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
}
/* Ort merken: Name (z. B. „KOM27“) → Adresse, damit er künftig direkt gefunden wird */
function rememberPlace(name, place) {
  if (!name || !place?.lat || normKey(name) === normKey(place.address || '')) return;
  S.placeAliases = { ...(S.placeAliases || {}), [normKey(name)]: { name, address: place.address || place.name, lat: place.lat, lon: place.lon, type: place.type === 'HOTEL' ? 'HOTEL' : 'PLACE' } };
  save();
}
/* Schlaue Suche für erkannte Ortsangaben: ganze Angabe → Adressteil → Name + Stadt → Name */
async function geocodeSmart(query, contextText = '') {
  const q = String(query || '').replace(/\s+/g, ' ').trim(); if (!q) return null;
  const addr = q.match(/([A-ZÄÖÜ][\wäöüß.\- ]{2,40}?\s\d{1,4}\s?[a-z]?)\s*,?\s*(\d{5})\s+([A-ZÄÖÜ][\wäöüß\- ]+)/);
  const name = q.split(/[,–|]| - | in (?=[A-ZÄÖÜ])/)[0].trim();
  const city = addr?.[3] || (contextText.match(/\b\d{5}\s+([A-ZÄÖÜ][\wäöüß\-]+)/) || [])[1]
    || (contextText.match(/\b(Berlin|Hamburg|München|Köln|Frankfurt|Aachen|Düsseldorf|Stuttgart|Leipzig|Dresden|Hannover|Bonn|Bremen|Nürnberg|Essen|Dortmund|Mainz|Wiesbaden|Potsdam|Karlsruhe|Mannheim|Münster|Freiburg|Erfurt|Kassel)\b/) || [])[1]
    || geoContext()?.city || '';
  const nameWords = normKey(name).split(' ').filter(w => w.length > 2 && normKey(city) !== w);
  for (const tryQ of [addr && `${addr[1]}, ${addr[2]} ${addr[3]}`, q, name && city && `${name} ${city}`, name].filter(Boolean)) {
    // Ohne Adresse nur Treffer akzeptieren, die den Namen wirklich enthalten (sonst lieber nachfragen als raten)
    const r = (await geocode(tryQ)).filter(x => x.type !== 'STOP')
      .filter(x => (addr && tryQ.startsWith(addr[1])) || x.known || !nameWords.length || nameWords.some(w => normKey(`${x.name} ${x.address}`).includes(w)));
    if (r.length) {
      const p = r[0];
      // Veranstaltungsort-Name behalten, Adresse aus dem Treffer
      if (name && tryQ !== name && normKey(p.name) !== normKey(name)) { const named = { ...p, name: name || p.name, address: p.address || p.name }; rememberPlace(name, named); return named; }
      return p;
    }
  }
  return null;
}
async function nearestStops(lat, lon) {
  try {
    const r = await getJSON(`${API}/v1/reverse-geocode?${qs({ place: `${lat},${lon}`, type: 'STOP' })}`);
    return r.slice(0, 6).map(x => ({ name: x.name, lat: x.lat, lon: x.lon, stopId: x.id, type: 'STOP', dist: haversine({ lat, lon }, x) }));
  } catch { return []; }
}
async function planJourney(from, to, { time, arriveBy = false, directModes = 'WALK', num = 5, transitModes, maxDirectTime } = {}) {
  const p = { fromPlace: placeParam(from), toPlace: placeParam(to), time: time ? new Date(time).toISOString() : undefined, arriveBy, directModes, numItineraries: num, transitModes, maxDirectTime, minTransferTime: S.settings.transferMin > 2 ? Math.max(0, S.settings.transferMin - 2) : undefined };
  return getJSON(`${API}/v5/plan?${qs(p)}`, {}, 30000);
}
const getTrip = tripId => getJSON(`${API}/v5/trip?${qs({ tripId })}`);
const stopTimes = (stopId, time, n = 40, mode) => getJSON(`${API}/v5/stoptimes?${qs({ stopId, time: time ? new Date(time).toISOString() : undefined, n, mode })}`);
const RAIL_MODES = 'HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_FAST_RAIL,REGIONAL_RAIL,SUBURBAN,COACH';

async function hereCar(from, to) {
  if (!S.settings.hereKey) return null;
  try {
    const r = await getJSON(`https://router.hereapi.com/v8/routes?${qs({ transportMode: 'car', origin: `${from.lat},${from.lon}`, destination: `${to.lat},${to.lon}`, return: 'summary', departureTime: new Date().toISOString(),apikey: S.settings.hereKey })}`);
    const s = r.routes?.[0]?.sections?.[0]?.summary;
    return s ? { duration: s.duration, base: s.baseDuration, length: s.length } : null;
  } catch (e) { console.warn('here', e); return null; }
}

/* Claude (optional, Schlüssel bleibt auf dem Gerät) */
async function claude(content, system, maxTokens = 1500) {
  if (!S.settings.claudeKey) throw new Error('Kein Claude-Schlüssel hinterlegt');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-api-key': S.settings.claudeKey,
      'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model: S.settings.claudeModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] })
  });
  if (!r.ok) throw new Error(`Claude HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

/* Polyline (MOTIS legGeometry) */
function decodePolyline(str, precision = 6) {
  let idx = 0, lat = 0, lon = 0; const pts = [], f = 10 ** precision;
  while (idx < str.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(idx++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (res & 1) ? ~(res >> 1) : (res >> 1);
      if (k === 0) lat += d; else lon += d;
    }
    pts.push([lat / f, lon / f]);
  }
  return pts;
}

/* ───────────── GPS ───────────── */
const GPS = { pos: null, watch: null, history: [] };
function startGPS() {
  if (!('geolocation' in navigator)) { setBadge('#gpsBadge', 'GPS fehlt', 'bad'); return; }
  if (GPS.watch !== null) return;
  GPS.watch = navigator.geolocation.watchPosition(p => {
    GPS.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, speed: p.coords.speed, t: Date.now() };
    GPS.history.push(GPS.pos); if (GPS.history.length > 60) GPS.history.shift();
    const kmh = speedKmh();
    setBadge('#gpsBadge', kmh > 8 ? `GPS · ${Math.round(kmh)} km/h` : 'GPS an', 'on');
    trackPoint(GPS.pos);
    onGPSUpdate();
    guideOnGPS();
  }, err => { setBadge('#gpsBadge', 'GPS gesperrt', 'bad'); console.warn(err); }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
}
function speedKmh() {
  if (GPS.pos?.speed != null && GPS.pos.speed >= 0) return GPS.pos.speed * 3.6;
  const h = GPS.history; if (h.length < 2) return 0;
  const a = h[Math.max(0, h.length - 5)], b = h[h.length - 1];
  const dt = (b.t - a.t) / 3600000; return dt > 0 ? haversine(a, b) / 1000 / dt : 0;
}
function getPosOnce() {
  if (GPS.pos && Date.now() - GPS.pos.t < 60000) return Promise.resolve(GPS.pos);
  return new Promise((res, rej) => navigator.geolocation.getCurrentPosition(p => {
    GPS.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() }; startGPS(); res(GPS.pos);
  }, rej, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }));
}
function setBadge(sel, text, cls) { const b = $(sel); b.textContent = text; b.className = 'badge ' + (cls || 'muted'); }

/* ───────────── Mitteilungen & Assistenz-Feed ───────────── */
let swReg = null;
function feed(title, body, level = 'info', extra = {}) {
  const m = { id: uid(), t: new Date().toISOString(), title, body, level, from: 'bot', ...extra };
  S.feed.push(m); if (S.feed.length > 300) S.feed = S.feed.slice(-300); save();
  if (currentView !== 'assist') $('#feedDot').classList.remove('hidden');
  if (currentView === 'assist') renderAssist();
  return m;
}
async function notify(key, title, body, level = 'info', extra = {}) {
  // Dublettenschutz pro Reise
  if (S.active && key) {
    S.active.notified ||= {};
    if (S.active.notified[key]) return;
    S.active.notified[key] = Date.now();
  }
  // push:false → nur im Verlauf, kein Ton/Banner (z. B. Verspätung einer Fahrt, die man ohnehin nicht mehr nimmt)
  const push = extra.push !== false;
  const m = feed(title, body, level, extra);
  if (!push) return;
  showBuddy(m); renderLive();
  if (S.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const opts = { body, icon: 'icon-192.png', badge: 'icon-192.png', tag: key || uid(), renotify: true, vibrate: [120, 60, 120] };
      if (swReg) await swReg.showNotification(title, opts); else new Notification(title, opts);
    } catch (e) { console.warn(e); }
  }
  if (level !== 'info' && navigator.vibrate) navigator.vibrate([150, 80, 150]);
  if (S.settings.voice && 'speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(`${title}. ${body || ''}`); u.lang = 'de-DE'; speechSynthesis.speak(u);
  }
}
async function askNotifyPermission() {
  if (!('Notification' in window)) { toast('Mitteilungen: App erst zum Home-Bildschirm hinzufügen (iOS 16.4+)'); return; }
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? 'Mitteilungen aktiviert ✓' : 'Mitteilungen nicht erlaubt');
  render();
}
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => wakeLock = null); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* nicht unterstützt */ }
}

/* ───────────── Reise-Engine ───────────── */
const isTransit = l => l && l.mode !== 'WALK' && l.mode !== 'BIKE' && l.mode !== 'CAR' && l.mode !== 'RENTAL' && l.mode !== 'FLEX';
const LONG = ['HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL', 'REGIONAL_FAST_RAIL', 'REGIONAL_RAIL', 'RAIL', 'COACH'];
const modeIcon = m => ({ WALK: '🚶', BIKE: '🚲', CAR: '🚗', BUS: '🚌', TRAM: '🚋', SUBWAY: '🚇', SUBURBAN: '🚆', HIGHSPEED_RAIL: '🚄', LONG_DISTANCE: '🚄', NIGHT_RAIL: '🛌', REGIONAL_RAIL: '🚆', REGIONAL_FAST_RAIL: '🚆', RAIL: '🚆', COACH: '🚌', FERRY: '⛴️', AIRPLANE: '✈️' }[m] || '🚉');
const legName = l => l.displayName || l.routeShortName || (l.tripShortName ? `${l.routeShortName || ''} ${l.tripShortName}` : l.mode);
const legColor = l => l.routeColor ? `#${l.routeColor}` : ({ HIGHSPEED_RAIL: '#ec0016', LONG_DISTANCE: '#ec0016', REGIONAL_RAIL: '#6b7280', SUBURBAN: '#008d4f', SUBWAY: '#115d91', BUS: '#a5027d', TRAM: '#cc0000' }[l.mode] || '#5b4bf5');
const itinEnd = it => it.legs[it.legs.length - 1]?.endTime || it.endTime;
const itinSchedEnd = it => { const l = it.legs[it.legs.length - 1]; return l?.scheduledEndTime || l?.endTime || it.endTime; };

function activeEvent() { return S.events.find(e => e.id === S.active?.eventId); }
function nextEvent() {
  const now = Date.now() - 3 * 3600e3;
  return S.events.filter(e => !e.done && (!e.start || new Date(e.start).getTime() > now)).sort((a, b) => (a.start ? new Date(a.start) : Date.now()) - (b.start ? new Date(b.start) : Date.now()))[0];
}

/* Neuer Plan: von Ort/GPS zu Termin */
async function planTo(ev, origin, when, arriveBy) {
  const r = await planJourney(origin, ev.place, { time: when, arriveBy, num: 6 });
  const its = [...(r.itineraries || [])];
  (r.direct || []).forEach(d => its.push({ ...d, direct: true }));
  return its.sort((a, b) => new Date(itinEnd(a)) - new Date(itinEnd(b)));
}

function startCompanion(ev, itinerary, ride = null, confirmed = false) {
  // Eine laufende Begleitung wird nie stillschweigend ersetzt – nur nach ausdrücklicher Bestätigung
  if (S.active && !confirmed) return guardCompanion(ev, itinerary, ride);
  S.active = { eventId: ev.id, itinerary, ride, plannedEta: itinEnd(itinerary), lastEta: itinEnd(itinerary), notified: {}, startedAt: new Date().toISOString(), lastRefresh: null };
  save();
  feed('Begleitung gestartet', `Ziel: ${ev.title}\nGeplante Ankunft ${fmtT(itinEnd(itinerary))}. Ich melde mich bei Verspätungen, Gleiswechseln, gefährdeten Anschlüssen und vor jedem Umstieg.`, 'ok');
  startGPS(); keepAwake(S.settings.wakeLock); startLoop(); go('jetzt'); refreshActive(true);
}
function stopCompanion(done = false) {
  const ev = activeEvent();
  if (done && ev) { ev.done = true; remindReceipts(ev); feed('Reise archivieren?', `Möchtest du „${ev.title}“ archivieren? Ich frage dich nach einem Titel und dem Anlass – Belege bleiben mind. 30 Tage gespeichert.`, 'info', { action: 'archive', evId: ev.id, push: false }); }
  if (S.active?.trackDist && ev) feed('Reise-Protokoll', `Per GPS aufgezeichnet: ${fmtKm(S.active.trackDist)} von ${fmtT(S.active.startedAt)} bis ${fmtT(new Date().toISOString())}.`, 'info', { push: false });
  S.active = null; save(); if (!S.drive) keepAwake(false); render();
  if (done) maybeAskFeedback('trip');
}

/* Echtzeit-Abgleich einer Teilstrecke über die Fahrt (tripId) */
function matchStop(stops, ref) {
  return stops.find(s => s.stopId === ref.stopId) || stops.find(s => ref.parentId && s.parentId === ref.parentId) || stops.find(s => s.name === ref.name);
}
async function refreshLeg(leg) {
  if (!isTransit(leg) || !leg.tripId) return leg;
  const t = await getTrip(leg.tripId);
  const tl = t.legs?.[0]; if (!tl) return leg;
  const all = [tl.from, ...(tl.intermediateStops || []), tl.to];
  const f = matchStop(all, leg.from), to = matchStop(all, leg.to);
  if (f) Object.assign(leg.from, { departure: f.departure, scheduledDeparture: f.scheduledDeparture, track: f.track, scheduledTrack: f.scheduledTrack, cancelled: f.cancelled });
  if (to) Object.assign(leg.to, { arrival: to.arrival, scheduledArrival: to.scheduledArrival, track: to.track, scheduledTrack: to.scheduledTrack, cancelled: to.cancelled });
  if (f && to) {
    const i1 = all.indexOf(f), i2 = all.indexOf(to);
    if (i2 > i1) leg.intermediateStops = all.slice(i1 + 1, i2);
    leg._remaining = all.slice(i1 + 1); // für Ausstiegs-Alternativen
    leg._all = all;
  }
  leg.startTime = leg.from.departure || leg.startTime; leg.endTime = leg.to.arrival || leg.endTime;
  leg.cancelled = !!(tl.cancelled || f?.cancelled || to?.cancelled);
  leg.realTime = tl.realTime;
  if (tl.legGeometry && !leg.legGeometry) leg.legGeometry = tl.legGeometry;
  return leg;
}

/* Reitet man bereits in einem Zug: Fahrt + Anschluss zum Ziel zusammensetzen */
async function buildRideItinerary(ride, ev) {
  const t = await getTrip(ride.tripId);
  const tl = t.legs[0];
  const all = [tl.from, ...(tl.intermediateStops || []), tl.to];
  let boardIdx = all.findIndex(s => s.stopId === ride.boardStopId || (ride.boardParentId && s.parentId === ride.boardParentId));
  if (boardIdx < 0 && ride.boardLat) { // Haltestellen-IDs unterscheiden sich je nach Datenquelle → über Entfernung zuordnen
    let best = Infinity; all.forEach((s, i) => { const d = haversine(s, { lat: ride.boardLat, lon: ride.boardLon }); if (d < best && d < 1500) { best = d; boardIdx = i; } });
  }
  boardIdx = Math.max(0, boardIdx);
  const after = all.slice(boardIdx + 1);
  // Ausstiegskandidaten: gewählter Ausstieg, Endhalt, Halt nächst am Ziel, große Knoten
  // Ausstiegskandidaten: Ticket-/Plan-Ausstieg + die 2 Halte davor (vorletzter, vorvorletzter), Halt nächst am Ziel,
  // Endhalt, große Knoten. Vergangene oder entfallende Halte fallen raus.
  const now = Date.now();
  const live = after.filter(s => !s.cancelled && new Date(s.arrival || s.scheduledArrival).getTime() > now);
  const planId = ride.exitStopId || ride.planExitId || (ride.ticketTo && live.find(s => s.name.toLowerCase().includes(ride.ticketTo.toLowerCase()))?.stopId);
  const planIdx = live.findIndex(s => s.stopId === planId);
  const byDist = [...live].sort((a, b) => haversine(a, ev.place) - haversine(b, ev.place));
  const hubs = live.filter(s => /hbf|hauptbahnhof|südkreuz|gesundbrunnen|spandau|ostbahnhof|flughafen|airport/i.test(s.name));
  const before = planIdx > 0 ? live.slice(Math.max(0, planIdx - 2), planIdx) : [];
  const cands = [...new Set([live[planIdx], ...before, byDist[0], live[live.length - 1], ...hubs.slice(-2)].filter(Boolean))].slice(0, 6);
  const options = await Promise.all(cands.map(async s => {
    const arr = s.arrival || s.scheduledArrival;
    const trainLeg = { ...tl, from: all[boardIdx], to: s, startTime: all[boardIdx].departure, endTime: arr, scheduledStartTime: all[boardIdx].scheduledDeparture, scheduledEndTime: s.scheduledArrival, intermediateStops: all.slice(boardIdx + 1, all.indexOf(s)), _all: all, _remaining: after };
    if (haversine(s, ev.place) < 250) return { exit: s, itinerary: { legs: [trainLeg], startTime: trainLeg.startTime, endTime: arr } };
    try {
      const its = await planTo(ev, { lat: s.lat, lon: s.lon, stopId: s.stopId }, new Date(new Date(arr).getTime() + S.settings.transferMin * 60e3), false);
      const best = bySafety(its)[0]; if (!best) return null;
      return { exit: s, itinerary: { legs: [trainLeg, ...best.legs], startTime: trainLeg.startTime, endTime: itinEnd(best) } };
    } catch { return null; }
  }));
  // sortiert nach „sicherster schneller Ankunft“ (Umstiege & knappe Übergänge kosten Punkte)
  const valid = options.filter(Boolean).sort((a, b) => riskScore(a.itinerary) - riskScore(b.itinerary));
  return { best: valid[0], options: valid, all, boardIdx, tripLeg: tl };
}

let loopTimer = null, refreshing = false;
function startLoop() {
  clearInterval(loopTimer);
  if (!S.active) { setBadge('#liveBadge', 'Live aus'); return; }
  loopTimer = setInterval(() => refreshActive(), S.settings.refreshSec * 1000);
}
async function refreshActive(force = false) {
  if (!S.active || refreshing) return;
  const ev = activeEvent(); if (!ev) { S.active = null; save(); return; }
  refreshing = true; setBadge('#liveBadge', 'Abgleich…', 'warn');
  try {
    const A = S.active;
    if (A.ride) {
      const res = await buildRideItinerary(A.ride, ev);
      if (res.options.length) {
        // Der Plan bleibt stabil (Ticket-/gewählter Ausstieg) – gewechselt wird nur auf Empfehlung bei gravierender Störung
        if (!A.ride.planExitId) A.ride.planExitId = A.ride.exitStopId || res.options[0].exit.stopId;
        const planId = A.ride.exitStopId || A.ride.planExitId;
        const cur = res.options.find(o => o.exit.stopId === planId) || res.options[0];
        A.itinerary = cur.itinerary;
        A.rideOptions = res.options.map(o => ({ exit: o.exit, eta: o.itinerary.endTime, transfers: transfersOf(o.itinerary) }));
        A.ride.suggestedExit = cur.exit.stopId;
        const sev = severity(A, ev), top = res.options[0];
        if (sev.severe && top !== cur && clearlyBetter(top.itinerary, cur.itinerary)) {
          const earlier = res.all.indexOf(res.all.find(s => s.stopId === top.exit.stopId)) < res.all.indexOf(res.all.find(s => s.stopId === cur.exit.stopId));
          A.ride.recommendExit = top.exit.stopId;
          notify(`exit-${top.exit.stopId}`, `${earlier ? 'Früher' : 'Woanders'} aussteigen: ${top.exit.name}`,
            `${sev.reason}. Über ${top.exit.name} (an ${fmtT(top.exit.arrival)}) bist du um ${fmtT(top.itinerary.endTime)} am Ziel statt ${fmtT(cur.itinerary.endTime)} – ${transfersOf(top.itinerary)} Umstieg(e).` +
            (earlier ? ` Früher aussteigen ist mit deinem Ticket erlaubt; für die Weiterfahrt ggf. ein Nahverkehrsticket lösen.` : ` Achtung: Dein Ticket gilt evtl. nur bis ${cur.exit.name}.`),
            'bad', { action: 'takeExit', exitId: top.exit.stopId });
        } else A.ride.recommendExit = null;
      }
    } else {
      for (const leg of A.itinerary.legs) { try { await refreshLeg(leg); } catch (e) { console.warn('refreshLeg', e); } }
      // Fußwege an neue Zeiten anpassen
      recomputeWalks(A.itinerary);
    }
    A.lastRefresh = new Date().toISOString();
    evaluate(A, ev);
    save(); setBadge('#liveBadge', `Live · ${fmtT(A.lastRefresh)}`, 'on');
  } catch (e) {
    console.warn(e); setBadge('#liveBadge', 'Offline', 'bad');
  } finally { refreshing = false; if (currentView === 'jetzt') renderJetzt(); renderLive(); }
}
function recomputeWalks(it) {
  for (let i = 0; i < it.legs.length; i++) {
    const l = it.legs[i];
    if (isTransit(l)) continue;
    const prev = it.legs[i - 1];
    if (prev && isTransit(prev)) {
      const dur = new Date(l.endTime) - new Date(l.startTime);
      l.startTime = prev.endTime; l.endTime = new Date(new Date(prev.endTime).getTime() + dur).toISOString();
    }
  }
  const last = it.legs[it.legs.length - 1]; it.endTime = last.endTime;
}

/* Regeln der Assistenz
 * Grundsatz: Gepusht wird nur, was für DICH eine Handlung oder eine neue Ankunftszeit bedeutet.
 *  - Fahrten nach einem gerissenen Anschluss sind „hinfällig“ (_void): deren Verspätungen interessieren nicht mehr,
 *    stattdessen kommt EINE Meldung mit fertig berechneter Alternative.
 *  - Reine Verspätungen einzelner Fahrten landen still im Verlauf; gepusht wird die Auswirkung auf deine Ankunft
 *    bzw. die Abfahrtsverspätung des Zuges, auf den du gerade wartest.
 */
function evaluate(A, ev) {
  const it = A.itinerary, legs = it.legs, now = Date.now(), th = S.settings.delayThreshold;
  const transit = legs.filter(isTransit);
  transit.forEach(l => { delete l._void; delete l._buffer; });
  // 1) Anschlüsse & Ausfälle
  let broken = null;
  for (let i = 0; i < transit.length - 1; i++) {
    const a = transit[i], b = transit[i + 1];
    const ia = legs.indexOf(a), ib = legs.indexOf(b);
    const walk = legs.slice(ia + 1, ib).reduce((s, l) => s + (new Date(l.endTime) - new Date(l.startTime)), 0);
    const buffer = mins(new Date(b.startTime) - new Date(a.endTime) - walk);
    a._buffer = buffer;
    if (broken || new Date(b.startTime) < now) continue;
    if (buffer < 0) broken = { a, b, why: 'miss' };
    else if (buffer < (LONG.includes(b.mode) || LONG.includes(a.mode) ? 3 : 1)) notify(`tight-${b.tripId}`, 'Knapper Umstieg', `Nur ${buffer} Min für ${legName(b)}${b.from.track ? ' (Gleis ' + b.from.track + ')' : ''} in ${b.from.name}. Zügig umsteigen!`, 'warn');
  }
  const cxl = transit.find(l => l.cancelled && new Date(l.endTime) > now);
  if (cxl && (!broken || transit.indexOf(cxl) < transit.indexOf(broken.b))) broken = { a: transit[transit.indexOf(cxl) - 1] || null, b: cxl, why: 'cxl' };
  if (broken) { transit.slice(transit.indexOf(broken.b)).forEach(l => l._void = true); handleBroken(A, ev, broken); }
  const relevant = transit.filter(l => !l._void && new Date(l.endTime) > now);
  const waitingFor = relevant.find(l => new Date(l.startTime) > now);
  // 2) Verspätungen & Gleiswechsel – nur für Fahrten, die du noch nimmst
  relevant.forEach(l => {
    const dd = delayOf(l.from.departure, l.from.scheduledDeparture), da = delayOf(l.to.arrival, l.to.scheduledArrival);
    if (l === waitingFor && dd >= th && new Date(l.startTime) - now < 90 * 60e3)
      notify(`depdelay-${l.tripId}-${Math.floor(dd / th)}`, `${legName(l)} fährt ${dd} Min später`, `Neue Abfahrt ${fmtT(l.startTime)} ab ${l.from.name}${l.from.track ? ', Gleis ' + l.from.track : ''}. Kein Grund zur Eile.`, 'warn');
    else if (Math.max(dd, da) >= th) notify(`delay-${l.tripId}-${Math.floor(Math.max(dd, da) / th)}`, `${legName(l)}: +${Math.max(dd, da)} Min`, `Ab ${l.from.name} ${fmtT(l.from.departure)} · an ${l.to.name} ${fmtT(l.to.arrival)}`, 'warn', { push: false });
    if (l === waitingFor && l.from.track && l.from.scheduledTrack && l.from.track !== l.from.scheduledTrack)
      notify(`trk-${l.tripId}-${l.from.track}`, `Gleiswechsel: Gleis ${l.from.track}`, `${legName(l)} fährt in ${l.from.name} von Gleis ${l.from.track} (statt ${l.from.scheduledTrack}).`, 'warn');
  });
  // 2b) Gravierende Störung auf der laufenden Fahrt → früheren Ausstieg prüfen (nur bei belastbarem Vorteil melden)
  if (!broken && !A.ride) checkEarlyExit(A, ev);
  // 3) Gesamt-Ankunft verschoben (nur wenn der Plan noch trägt – sonst kommt die Alternative)
  const eta = itinEnd(it), diff = mins(new Date(eta) - new Date(A.lastEta || eta));
  if (!broken && Math.abs(diff) >= th) {
    notify(`eta-${eta}`, `Neue Ankunft: ${fmtT(eta)}`, `${diff > 0 ? '+' : ''}${diff} Min gegenüber der letzten Meldung · Ziel ${ev.title}`, diff > 0 ? 'warn' : 'ok');
    A.lastEta = eta;
  }
  if (ev.start && new Date(eta) > new Date(ev.start)) notify(`late-${ev.id}-${Math.floor(mins(new Date(eta) - new Date(ev.start)) / 10)}`, 'Du kommst später an', `Termin „${ev.title}“ um ${fmtT(ev.start)} – voraussichtlich ${mins(new Date(eta) - new Date(ev.start))} Min später. Soll ich jemandem Bescheid geben? (Im Assistenz-Tab Nachricht entwerfen)`, 'warn');
  // 5) Abfahrt & Ausstieg rechtzeitig ankündigen (nur gültige Fahrten)
  const lead = S.settings.alightLead * 60e3;
  transit.forEach((l, k) => {
    if (l._void) return;
    const dep = new Date(l.startTime).getTime(), arr = new Date(l.endTime).getTime();
    if (dep - now < 10 * 60e3 && dep > now) notify(`dep-${l.tripId}`, `Gleich: ${legName(l)}`, `Abfahrt ${fmtT(l.startTime)} ab ${l.from.name}${l.from.track ? ', Gleis ' + l.from.track : ''} → ${l.headsign || l.to.name}`, 'info');
    if (arr - now < lead && arr > now) {
      const nx = transit.slice(k + 1).find(x => !x._void);
      notify(`alight-${l.tripId}`, `Nächster Halt: ${l.to.name}`, nx ? `Aussteigen! Weiter mit ${legName(nx)} um ${fmtT(nx.startTime)}${nx.from.track ? ', Gleis ' + nx.from.track : ''}.` : `Aussteigen – danach ${lastMileHint(ev)}`, 'warn');
    }
  });
  // 6) Angekommen?
  const atDest = GPS.pos && haversine(GPS.pos, ev.place) < 200;
  if (atDest || now > new Date(eta).getTime() + 15 * 60e3) {
    notify(`arr-${ev.id}`, `Angekommen: ${ev.title}`, ev.kind === 'hotel' ? `Check-in${ev.checkIn ? ' ab ' + ev.checkIn : ''}. Buchungsnummer & Ausweis bereithalten. Gute Erholung!` : 'Du bist da. Viel Erfolg!', 'ok');
    if (atDest) setTimeout(() => stopCompanion(true), 1500);
  }
}
/* ───── Eingriffsregeln ─────
 * Aktiv eingreifen (Umstieg/Ausstieg empfehlen) nur, wenn
 *   1) die Störung gravierend ist: Ausfall, gerissener Anschluss, ≥ interveneDelay Min (Standard 20) Verspätung
 *      oder Störung auf der Reststrecke (entfallender Halt, Verspätungssprung zwischen zwei Halten), und
 *   2) die neue Verbindung belastbar besser ist: ≥ minGain Min früher UND nach Risikoabzug besser;
 *      jeder Umstieg kostet transferPenalty Min „Risiko“, knappe Übergänge zusätzlich. Mehr Umstiege als bisher
 *      nur bei doppeltem Zeitgewinn.
 */
const transfersOf = it => Math.max(0, it.legs.filter(isTransit).length - 1);
function riskScore(it) {
  const legs = it.legs, tr = legs.filter(isTransit), st = S.settings;
  let pen = transfersOf(it) * st.transferPenalty;
  for (let i = 0; i < tr.length - 1; i++) {
    const walk = legs.slice(legs.indexOf(tr[i]) + 1, legs.indexOf(tr[i + 1])).reduce((s, l) => s + (new Date(l.endTime) - new Date(l.startTime)), 0);
    const buf = mins(new Date(tr[i + 1].startTime) - new Date(tr[i].endTime) - walk);
    pen += buf < 0 ? 999 : buf < 3 ? 12 : buf < 6 ? 5 : 0;
  }
  if (tr.some(l => l.cancelled)) pen += 999;
  if (tr.length && !tr.some(l => l.realTime)) pen += 5; // ohne Echtzeitdaten unsicherer
  return new Date(itinEnd(it)).getTime() / 60000 + pen;
}
const bySafety = its => [...(its || [])].sort((a, b) => riskScore(a) - riskScore(b));
function clearlyBetter(cand, cur) {
  if (cand.legs.some(l => isTransit(l) && l.cancelled)) return false;
  if (cur.legs.some(l => isTransit(l) && l.cancelled && new Date(l.endTime) > Date.now())) return true;
  const st = S.settings, etaGain = mins(new Date(itinEnd(cur)) - new Date(itinEnd(cand)));
  const riskGain = riskScore(cur) - riskScore(cand), extra = transfersOf(cand) - transfersOf(cur);
  return etaGain >= st.minGain && riskGain >= st.minGain && (extra <= 0 || etaGain >= 2 * st.minGain);
}
function segmentIssue(l) {
  const all = l._all; if (!all) return null;
  const now = Date.now(), iTo = all.findIndex(s => s.stopId === l.to.stopId || s.name === l.to.name);
  const rest = all.slice(0, iTo < 0 ? all.length : iTo + 1).filter(s => new Date(s.arrival || s.departure || 0).getTime() > now);
  const cx = rest.find(s => s.cancelled); if (cx) return `Halt ${cx.name} entfällt`;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i - 1], b = rest[i];
    const jump = delayOf(b.arrival, b.scheduledArrival) - delayOf(a.departure || a.arrival, a.scheduledDeparture || a.scheduledArrival);
    if (jump >= S.settings.interveneDelay) return `Störung zwischen ${a.name} und ${b.name} (+${jump} Min)`;
  }
  return null;
}
function severity(A, ev) {
  const lim = S.settings.interveneDelay, now = Date.now(), it = A.itinerary;
  for (const l of it.legs.filter(isTransit).filter(l => !l._void && new Date(l.endTime) > now)) {
    if (l.cancelled) return { severe: true, reason: `${legName(l)} fällt aus` };
    const seg = segmentIssue(l); if (seg) return { severe: true, reason: seg };
    const d = delayOf(l.to.arrival, l.to.scheduledArrival); if (d >= lim) return { severe: true, reason: `${legName(l)} hat +${d} Min Verspätung` };
  }
  const late = mins(new Date(itinEnd(it)) - new Date(A.plannedEta));
  if (late >= lim) return { severe: true, reason: `Du kommst ${late} Min später an als geplant` };
  return { severe: false };
}
/* Früher aussteigen? Bei gravierender Störung die 1–3 Halte vor dem Ausstieg der aktuellen Fahrt prüfen */
async function checkEarlyExit(A, ev) {
  const sev = severity(A, ev); if (!sev.severe) return;
  if (checkEarlyExit._t && Date.now() - checkEarlyExit._t < 180000) return; checkEarlyExit._t = Date.now();
  const now = Date.now(), it = A.itinerary;
  const leg = it.legs.filter(isTransit).find(l => !l._void && l._all && new Date(l.endTime) > now); if (!leg) return;
  const all = leg._all, iTo = all.findIndex(s => s.stopId === leg.to.stopId || s.name === leg.to.name), iFrom = all.findIndex(s => s.stopId === leg.from.stopId || s.name === leg.from.name);
  const cands = all.slice(Math.max(iFrom + 1, iTo - 3), iTo).filter(s => !s.cancelled && new Date(s.arrival).getTime() > now);
  const li = it.legs.indexOf(leg);
  const opts = await Promise.all(cands.map(async s => {
    try {
      const best = bySafety(await planTo(ev, { lat: s.lat, lon: s.lon, stopId: s.stopId, name: s.name }, new Date(new Date(s.arrival).getTime() + S.settings.transferMin * 60e3), false))[0];
      if (!best) return null;
      const cut = { ...leg, to: s, endTime: s.arrival, scheduledEndTime: s.scheduledArrival, intermediateStops: all.slice(iFrom + 1, all.indexOf(s)) };
      return { exit: s, itinerary: { legs: [...it.legs.slice(0, li), cut, ...best.legs], startTime: it.legs[0].startTime, endTime: itinEnd(best) } };
    } catch { return null; }
  }));
  const best = opts.filter(Boolean).sort((a, b) => riskScore(a.itinerary) - riskScore(b.itinerary))[0];
  if (best && clearlyBetter(best.itinerary, it)) {
    A.alternative = best.itinerary; save();
    notify(`early-${best.exit.stopId}`, `Früher aussteigen: ${best.exit.name}`, `${sev.reason}. Steig in ${best.exit.name} aus (an ${fmtT(best.exit.arrival)}) – Ankunft am Ziel ${fmtT(best.itinerary.endTime)} statt ${fmtT(itinEnd(it))}, ${transfersOf(best.itinerary)} Umstieg(e). Früher aussteigen ist mit deinem Ticket erlaubt.`, 'bad', { action: 'adoptAlt' });
    if (currentView === 'jetzt') renderJetzt();
  }
}

/* Anschluss gerissen / Ausfall → sofort Alternative suchen und EINE Meldung mit Lösung schicken */
async function handleBroken(A, ev, br) {
  const key = `broken-${br.b.tripId}`;
  if (A.notified?.[key] || handleBroken._busy) return;
  handleBroken._busy = true;
  try {
    let origin, t;
    if (br.a) { origin = { lat: br.a.to.lat, lon: br.a.to.lon, stopId: br.a.to.stopId, name: br.a.to.name }; t = new Date(new Date(br.a.endTime).getTime() + 2 * 60e3); }
    else if (GPS.pos) { origin = { lat: GPS.pos.lat, lon: GPS.pos.lon, name: 'deinem Standort' }; t = new Date(); }
    else { origin = { ...br.b.from }; t = new Date(); }
    const its = await planTo(ev, origin, t, false);
    const best = bySafety(its.filter(i => i.legs.some(isTransit)))[0] || its[0]; // sicherste statt nur früheste
    const head = br.why === 'cxl' ? `${legName(br.b)} fällt aus` : `Anschluss ${legName(br.b)} nicht erreichbar`;
    if (!best) { notify(key, head, 'Ich finde gerade keine Alternative. Tippe auf „Neu planen“.', 'bad', { action: 'replan' }); return; }
    const first = best.legs.find(isTransit);
    const keep = br.a ? A.itinerary.legs.slice(0, A.itinerary.legs.indexOf(br.a) + 1) : [];
    A.alternative = { legs: [...keep, ...best.legs], startTime: A.itinerary.legs[0].startTime, endTime: itinEnd(best) };
    notify(key, head, first ? `Nimm stattdessen ${legName(first)} um ${fmtT(first.startTime)}${first.from.track ? ', Gleis ' + first.from.track : ''} ab ${first.from.name}. Ankunft am Ziel ${fmtT(itinEnd(best))}.` : `Weiter ${modeIcon(best.legs[0].mode)} – Ankunft ${fmtT(itinEnd(best))}.`, 'bad', { action: 'adoptAlt' });
    save(); if (currentView === 'jetzt') renderJetzt();
  } catch (e) { console.warn(e); } finally { handleBroken._busy = false; }
}
function adoptAlt() {
  const A = S.active; if (!A?.alternative) return;
  const it = A.alternative; delete A.alternative;
  Object.assign(A, { itinerary: it, ride: null, lastEta: itinEnd(it) }); save();
  feed('Alternative übernommen', `Neue Ankunft am Ziel ${fmtT(itinEnd(it))}. Ich begleite dich weiter.`, 'ok'); go('jetzt'); refreshActive(true);
}
function lastMileHint(ev) { return ev.kind === 'hotel' ? 'die letzte Meile zum Hotel (siehe „Vom Bahnhof zum Ziel“).' : `weiter zu ${ev.title}.`; }

/* GPS-Abgleich mit der Route */
function onGPSUpdate() {
  if (!S.active) return;
  const it = S.active.itinerary, now = Date.now();
  const cur = it.legs.find(l => isTransit(l) && new Date(l.startTime) <= now && new Date(l.endTime) >= now);
  if (!cur || !cur.legGeometry || !GPS.pos || GPS.pos.acc > 500) return;
  const pts = decodePolyline(cur.legGeometry.points, cur.legGeometry.precision || 6);
  let min = Infinity; for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 400))) min = Math.min(min, haversine(GPS.pos, { lat: pts[i][0], lon: pts[i][1] }));
  const limit = LONG.includes(cur.mode) ? 8000 : 1500;
  if (min > limit && speedKmh() > 20) notify(`offroute-${cur.tripId}`, 'Andere Strecke?', `Du bist ${fmtKm(min)} von der Route von ${legName(cur)} entfernt. Sitzt du in einem anderen Zug? Tippe „Zug wechseln“, dann plane ich neu.`, 'warn', { action: 'switchTrain' });
}

/* ───────────── Letzte Meile ───────────── */
async function lastMile(fromPlace, ev, time) {
  const p = { lat: fromPlace.lat, lon: fromPlace.lon };
  const [pt, pb, pc, here] = await Promise.allSettled([
    planJourney(p, ev.place, { time, directModes: 'WALK', num: 4, maxDirectTime: 5400 }),
    planJourney(p, ev.place, { time, directModes: 'BIKE', num: 1 }),
    planJourney(p, ev.place, { time, directModes: 'CAR', num: 1 }),
    hereCar(p, ev.place)
  ]);
  const ok = r => r.status === 'fulfilled' ? r.value : null;
  const transit = (ok(pt)?.itineraries || []).filter(i => i.legs.some(isTransit));
  const walk = (ok(pt)?.direct || []).find(d => d.legs[0].mode === 'WALK');
  const bike = (ok(pb)?.direct || []).find(d => d.legs[0].mode === 'BIKE');
  const car = (ok(pc)?.direct || []).find(d => d.legs[0].mode === 'CAR');
  const dist = haversine(p, ev.place);
  const carSec = ok(here)?.duration || car?.duration || (dist * 1.4 / 1000 / 25 * 3600);
  const carKm = (ok(here)?.length || car?.legs?.[0]?.distance || dist * 1.35) / 1000;
  const taxi = 4.3 + Math.min(carKm, 7) * 2.8 + Math.max(0, carKm - 7) * 2.1 + carSec / 60 * 0.15;
  return { transit, walk, bike, car: { duration: carSec, km: carKm, traffic: ok(here) ? Math.round((ok(here).duration - ok(here).base) / 60) : null }, taxi, dist, from: fromPlace };
}
function uberLink(ev, pos) {
  // Abholung: aktueller GPS-Standort (falls bekannt), sonst „mein Standort“ in der Uber-App; Ziel vorausgefüllt
  const pickup = pos ? { 'pickup[latitude]': pos.lat, 'pickup[longitude]': pos.lon, 'pickup[nickname]': pos.name || 'Mein Standort' } : { pickup: 'my_location' };
  return `https://m.uber.com/ul/?${qs({ action: 'setPickup', ...pickup, 'dropoff[latitude]': ev.place.lat, 'dropoff[longitude]': ev.place.lon, 'dropoff[nickname]': ev.place.name || ev.title, 'dropoff[formatted_address]': ev.place.address || '' })}`;
}
const appleMaps = (ev, flg) => `https://maps.apple.com/?${qs({ daddr: `${ev.place.lat},${ev.place.lon}`, dirflg: flg })}`;
const googleMaps = (ev, mode) => `https://www.google.com/maps/dir/?${qs({ api: 1, destination: `${ev.place.lat},${ev.place.lon}`, travelmode: mode })}`;

/* ───────────── Navigation & Rendering ───────────── */
let currentView = 'jetzt';
const TITLES = { jetzt: 'Jetzt', plan: 'Termine', kosten: 'Reisekosten', assist: 'Assistenz', mehr: 'Einstellungen' };
function go(v) {
  currentView = v; location.hash = v;
  $$('.view').forEach(x => x.classList.toggle('active', x.id === 'view-' + v));
  $$('.tabbar button[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('#screenTitle').textContent = TITLES[v];
  if (v === 'assist') $('#feedDot').classList.add('hidden');
  render(); window.scrollTo({ top: 0 });
}
function render() {
  ({ jetzt: renderJetzt, plan: renderPlan, kosten: renderKosten, assist: renderAssist, mehr: renderMehr })[currentView]();
  renderLive();
}

const KIND = { hotel: { ico: '🏨', label: 'Hotel' }, termin: { ico: '📅', label: 'Termin' }, zug: { ico: '🚄', label: 'Zugfahrt' }, ort: { ico: '📍', label: 'Ort' } };

function renderLegs(it) {
  const legs = it.legs; let h = '<div class="legs">';
  window._legsRef = legs;
  legs.forEach((l, i) => {
    const c = legColor(l);
    if (!isTransit(l)) {
      const d = (new Date(l.endTime) - new Date(l.startTime)) / 1000;
      if (d < 45 && i > 0 && i < legs.length - 1) return;
      h += `<div class="leg walk" style="--legc:var(--muted)"><div class="t">${fmtT(l.startTime)}</div><div class="rail"><div class="node"></div></div>
        <div class="body"><div class="stop">${i === 0 ? esc(l.from.name === 'START' ? 'Dein Standort' : l.from.name) : esc(l.from.name)}</div>
        <div class="meta">${modeIcon(l.mode)} ${fmtDur(d)} ${l.mode === 'WALK' ? 'Fußweg' : l.mode === 'BIKE' ? 'Rad' : 'Fahrt'}${l.distance ? ' · ' + fmtKm(l.distance) : ''}</div></div></div>`;
      return;
    }
    const dd = delayOf(l.from.departure, l.from.scheduledDeparture), da = delayOf(l.to.arrival, l.to.scheduledArrival);
    const trk = l.from.track ? `Gl. ${esc(l.from.track)}${l.from.scheduledTrack && l.from.track !== l.from.scheduledTrack ? ` <b style="color:var(--warn)">(statt ${esc(l.from.scheduledTrack)})</b>` : ''}` : '';
    const stops = (l.intermediateStops || []);
    h += `<div class="leg${l._void ? ' void' : ''}" style="--legc:${c}">
      <div class="t">${fmtT(l.startTime)}${dd ? `<s>${fmtT(l.from.scheduledDeparture)}</s>` : ''}</div>
      <div class="rail"><div class="node"></div></div>
      <div class="body">
        <div class="stop">${esc(l.from.name)}</div>
        <div class="meta"><span class="line-badge" style="--legc:${c}">${modeIcon(l.mode)} ${esc(legName(l))}</span>→ ${esc(l.headsign || l.to.name)}</div>
        <div class="meta">${trk}${dd ? ` · <b class="${dd > 0 ? '' : ''}" style="color:${dd > 0 ? 'var(--bad)' : 'var(--ok)'}">${dd > 0 ? '+' : ''}${dd} Min</b>` : (l.realTime ? ' · <span style="color:var(--ok)">pünktlich</span>' : '')}${l.agencyName ? ' · ' + esc(l.agencyName) : ''}</div>
        ${l.cancelled ? '<div class="badbox">Fällt aus – Alternativen über „Neu planen“</div>' : ''}
        ${['BUS', 'TRAM', 'COACH', 'SUBWAY', 'FERRY'].includes(l.mode) && !l._void && new Date(l.startTime) > Date.now() ? `<button class="btn ghost sm" style="padding-left:0" onclick="openStopFinder(window._legsRef[${i}])">📍 Haltestelle${l.from.track ? ' ' + esc(l.from.track) : ''} finden</button>` : ''}
        ${stops.length ? `<details class="stops"><summary>${stops.length} Zwischenhalte</summary><ol>${stops.map(s => `<li>${fmtT(s.arrival || s.departure)}${delayOf(s.arrival, s.scheduledArrival) > 0 ? ` <b style="color:var(--bad)">+${delayOf(s.arrival, s.scheduledArrival)}</b>` : ''} ${esc(s.name)}</li>`).join('')}</ol></details>` : ''}
        <div class="meta" style="margin-top:6px">an <b>${fmtT(l.endTime)}</b>${da ? ` <b style="color:${da > 0 ? 'var(--bad)' : 'var(--ok)'}">(${da > 0 ? '+' : ''}${da})</b>` : ''} ${esc(l.to.name)}${l.to.track ? ', Gl. ' + esc(l.to.track) : ''}</div>
        ${l._buffer != null && l._buffer < 3 ? `<div class="${l._buffer < 0 ? 'badbox' : 'warnbox'}">Umstieg: ${l._buffer < 0 ? 'nicht erreichbar' : 'nur ' + l._buffer + ' Min'}</div>` : (l._buffer != null ? `<div class="meta">Umstiegszeit ${l._buffer} Min</div>` : '')}
      </div></div>`;
  });
  const last = legs[legs.length - 1];
  h += `<div class="leg last" style="--legc:var(--accent2)"><div class="t">${fmtT(last.endTime)}</div><div class="rail"><div class="node"></div></div><div class="body"><div class="stop">🏁 ${esc(activeEvent()?.title || last.to.name)}</div></div></div></div>`;
  return h;
}
function itinSummary(it) {
  const t = it.legs.filter(isTransit);
  const chips = it.legs.filter(l => isTransit(l) || (it.legs.length === 1)).map(l => `<span class="line-badge" style="--legc:${legColor(l)}">${modeIcon(l.mode)} ${esc(isTransit(l) ? legName(l) : fmtDur(it.duration))}</span>`).join('');
  const d = it.legs.filter(isTransit).reduce((m, l) => Math.max(m, delayOf(l.to.arrival, l.to.scheduledArrival)), 0);
  return `<div class="spread"><div><b style="font-size:20px">${fmtT(it.startTime || it.legs[0].startTime)} → ${fmtT(itinEnd(it))}</b>${d > 0 ? ` <b style="color:var(--bad)">+${d}</b>` : ''}</div><div class="muted small">${fmtDur((new Date(itinEnd(it)) - new Date(it.startTime || it.legs[0].startTime)) / 1000)} · ${t.length ? (t.length - 1) + ' Umst.' : 'direkt'}</div></div><div class="row wrap" style="margin-top:8px;gap:4px">${chips}</div>`;
}

/* JETZT */
async function renderJetzt() {
  const el = $('#view-jetzt');
  const A = S.active, ev = A ? activeEvent() : nextEvent();
  let h = A ? '' : feedbackPromptCard(); // während der Fahrt nichts Unwichtiges oben
  if (!S.events.length) {
    h += `<div class="empty"><div class="ico">🧭</div><h3>Wohin geht's?</h3><p>Trag dein Ziel ein oder übernimm es aus einer E-Mail, einem Kalender oder einem Screenshot.</p><button class="btn primary" onclick="openAdd()">Ziel eintragen</button></div>`;
    el.innerHTML = h; return;
  }
  if (!A) {
    h += `<div class="hero"><div class="eyebrow">Nächstes Ziel</div><div class="dest">${KIND[ev?.kind]?.ico || '📍'} ${esc(ev?.title || '–')}</div>
      <div class="sub">${esc(ev?.place?.address || ev?.place?.name || '')}</div>
      <div class="sub" style="margin-top:6px">${ev?.start ? `${fmtD(ev.start)}, ${fmtT(ev.start)}` : 'Heute · Ankunftszeit offen'}${ev?.checkIn ? ` · Check-in ab ${esc(ev.checkIn)}` : ''}</div>
      <div class="sub" style="margin-top:6px">${ev?.plan ? prePlanLine(ev) + ` · <a href="#" style="color:#fff" onclick="openPrePlan('${ev.id}');return false">ändern</a>` : `<a href="#" style="color:#fff" onclick="openPrePlan('${ev?.id}');return false">🧭 Anreise vorab planen</a>`}</div>
      <div class="row wrap" style="margin-top:14px"><button class="btn primary" onclick="openStart('${ev?.id}')">▶︎ Begleitung starten</button><button class="btn" onclick="openRideSetup('${ev?.id}')">🚄 Ich sitze schon im Zug</button></div></div>`;
    h += `<div class="card"><h3>So funktioniert's</h3><div class="small muted">1. Ziel wählen · 2. Startpunkt (GPS oder Bahnhof) oder deinen aktuellen Zug wählen · 3. Ich gleiche laufend Echtzeitdaten, GPS und Anschlüsse ab und melde mich, sobald sich etwas ändert – inkl. Weg vom Zielbahnhof zum Ziel.</div></div>`;
    if (ev) h += `<div class="card" id="lmCard"><div class="eyebrow">Vom Bahnhof zum Ziel</div><div class="muted small" style="margin-top:6px">Wird berechnet, sobald die Reise läuft – oder jetzt <button class="btn ghost sm" onclick="previewLastMile('${ev.id}')">Vorschau ab Hauptbahnhof</button></div></div>`;
    el.innerHTML = h; return;
  }
  const it = A.itinerary, eta = itinEnd(it), late = mins(new Date(eta) - new Date(A.plannedEta));
  const start = new Date(it.startTime || it.legs[0].startTime).getTime(), end = new Date(eta).getTime();
  const prog = Math.min(100, Math.max(2, (Date.now() - start) / (end - start) * 100));
  const now = Date.now();
  const cur = it.legs.find(l => new Date(l.startTime) <= now && new Date(l.endTime) >= now);
  const nextT = it.legs.find(l => isTransit(l) && new Date(l.startTime) > now);
  const trainDelay = it.legs.filter(isTransit).reduce((m, l) => Math.max(m, delayOf(l.to.arrival, l.to.scheduledArrival)), 0);
  h += `<div class="hero ${late >= S.settings.delayThreshold || trainDelay >= 15 ? 'late' : ''}">
    <div class="spread"><div class="eyebrow">Ankunft am Ziel</div><button class="btn sm" onclick="refreshActive(true)">↻</button></div>
    <div class="dest">${KIND[ev.kind]?.ico || '📍'} ${esc(ev.title)}</div>
    <div class="row" style="margin-top:8px;align-items:flex-end"><div class="big">${fmtT(eta)}</div>${late ? `<span class="delta">${late > 0 ? '+' : ''}${late} Min</span>` : (trainDelay > 0 ? `<span class="delta">Zug +${trainDelay}</span>` : '<span class="delta">im Plan</span>')}</div>
    ${waypointsHtml(A, ev, now)}
    <div class="progress"><i style="width:${prog}%"></i></div>
    <div class="row" style="margin-top:12px;gap:6px"><button class="btn sm" onclick="replan()">⟲ Neu planen</button><button class="btn sm" onclick="openRideSetup('${ev.id}')">🔀 Zug</button><button class="btn sm" onclick="toggleMap()">🗺️ Karte</button><button class="btn sm" onclick="openTripMenu()">⋯</button></div>
  </div>`;
  if (A.alternative) {
    const f = A.alternative.legs.filter(isTransit).find(l => new Date(l.startTime) > Date.now());
    h += `<div class="card" style="border:2px solid var(--bad)"><b>⚠️ Dein Plan trägt nicht mehr</b><div class="small" style="margin-top:4px">Neue Verbindung: ${f ? `${esc(legName(f))} um ${fmtT(f.startTime)}${f.from.track ? ', Gl. ' + esc(f.from.track) : ''} ab ${esc(f.from.name)}` : ''} → Ziel ${fmtT(A.alternative.endTime)}</div><div class="row" style="margin-top:10px"><button class="btn primary" onclick="adoptAlt()">Übernehmen</button><button class="btn" onclick="replan()">Andere Optionen</button></div></div>`;
  }
  if (A.ride && A.rideOptions?.length > 1 && A.ride.recommendExit) { // nur zeigen, wenn wirklich ein anderer Ausstieg empfohlen wird
    h += `<div class="card"><h3>Wo aussteigen?</h3><div class="small muted">Ich prüfe laufend auch den vorletzten und vorvorletzten Halt. Einen Wechsel empfehle ich nur bei einer gravierenden Störung (ab ${S.settings.interveneDelay} Min) und wenn der andere Weg sicher besser ist.</div><div class="list" style="margin-top:10px">${A.rideOptions.map(o => `<div class="item" onclick="setExit('${o.exit.stopId}')" style="${o.exit.stopId === A.ride.recommendExit ? 'outline:2px solid var(--bad)' : ''}"><div class="ic">${o.exit.stopId === A.ride.suggestedExit ? '📍' : o.exit.stopId === A.ride.recommendExit ? '⚠️' : '🚉'}</div><div class="grow"><b>${esc(o.exit.name)}</b><div class="small muted">an ${fmtT(o.exit.arrival)}${delayOf(o.exit.arrival, o.exit.scheduledArrival) > 0 ? ' (+' + delayOf(o.exit.arrival, o.exit.scheduledArrival) + ')' : ''} · ${o.transfers ?? '?'} Umst. danach${o.exit.stopId === A.ride.suggestedExit ? ' · <b>dein Plan</b>' : o.exit.stopId === A.ride.recommendExit ? ' · <b style="color:var(--bad)">empfohlen</b>' : ''}</div></div><div class="when">Ziel ${fmtT(o.eta)}</div></div>`).join('')}</div>${A.ride.exitStopId ? '<button class="btn ghost sm" onclick="setExit(null)">Zurück zum ursprünglichen Plan</button>' : ''}</div>`;
  }
  h += `<div id="mapWrap" class="card hidden"><div id="map" class="map"></div></div>`;
  // Umschalter: Weg zum Ziel | Verbindung (Auswahl wird gemerkt)
  const tab = S.ui?.jetztTab || 'lm';
  h += `<div class="seg" style="margin-top:4px"><button class="${tab === 'lm' ? 'on' : ''}" onclick="setJetztTab('lm')">🏁 Weg zum Ziel</button><button class="${tab === 'conn' ? 'on' : ''}" onclick="setJetztTab('conn')">🚆 Verbindung</button></div>`;
  if (tab === 'conn') {
    // nur noch Relevantes: laufender und kommende Abschnitte; Vergangenes eingeklappt
    const restIdx = it.legs.findIndex(l => new Date(l.endTime).getTime() > now);
    const past = restIdx > 0 ? it.legs.slice(0, restIdx).filter(isTransit) : [];
    const rest = { ...it, legs: restIdx >= 0 ? it.legs.slice(restIdx) : it.legs };
    h += `<div class="card"><div class="spread"><span class="small muted">${A.lastRefresh ? 'Live-Stand ' + fmtT(A.lastRefresh) : ''}</span>${past.length ? `<span class="small muted">${past.length} Abschnitt(e) erledigt</span>` : ''}</div>${renderLegs(rest)}</div>`;
  } else {
    h += `<div class="card" id="lmCard"><div class="eyebrow">Vom Bahnhof zum Ziel</div><div class="row" style="margin-top:8px"><span class="spinner"></span><span class="muted small">Optionen werden berechnet…</span></div></div>`;
  }
  el.innerHTML = h;
  // Letzte Meile ab dem letzten Bahnhof der Verbindung
  const lastRail = lastMainLeg(it);
  if (lastRail) renderLastMile(lastRail.to, ev, lastRail.endTime);
  else $('#lmCard')?.remove();
}
function setJetztTab(t) { S.ui = { ...(S.ui || {}), jetztTab: t }; save(); renderJetzt(); }
function openTripMenu() {
  openSheet(`<h2>Reise</h2><div class="list" style="margin-top:10px">
    <button class="btn block" onclick="closeSheet();stopCompanion(true)">✓ Angekommen</button>
    <button class="btn block" onclick="closeSheet();openExpense()">🧾 Beleg erfassen</button>
    <button class="btn block" onclick="closeSheet();go('assist')">✦ Assistenz & Verlauf</button>
    <button class="btn block danger" onclick="if(confirm('Begleitung beenden?')){closeSheet();stopCompanion(false)}">Begleitung beenden</button></div>`);
}
async function previewLastMile(id) {
  const ev = S.events.find(e => e.id === id);
  const hb = await nearestStops(ev.place.lat, ev.place.lon);
  // nächster großer Bahnhof Richtung Ziel: Hauptbahnhof der Stadt suchen
  const g = (await geocode(`${(ev.place.address || '').match(/\d{5}\s+([^,]+)/)?.[1] || 'Berlin'} Hauptbahnhof`)).find(x => x.type === 'STOP') || hb[0];
  if (g) renderLastMile(g, ev, new Date().toISOString());
}
let lmCache = {};
async function renderLastMile(station, ev, time) {
  const card = $('#lmCard'); if (!card) return;
  const key = `${station.name}|${ev.id}|${Math.round(new Date(time).getTime() / 600000)}`;
  let lm = lmCache[key];
  if (!lm) { try { lm = lmCache[key] = await lastMile(station, ev, time); } catch (e) { card.innerHTML = `<div class="eyebrow">Vom Bahnhof zum Ziel</div><div class="badbox">Konnte nicht berechnet werden (${esc(e.message)})</div>`; return; } }
  const c = $('#lmCard'); if (!c) return;
  const bt = lm.transit[0];
  const opts = [
    bt && { k: 'oepnv', ico: '🚇', v: fmtDur((new Date(itinEnd(bt)) - new Date(time)) / 1000), l: `ÖPNV · ${bt.legs.filter(isTransit).map(legName).join(' + ')}`, sec: (new Date(itinEnd(bt)) - new Date(time)) / 1000 },
    lm.walk && { k: 'walk', ico: '🚶', v: fmtDur(lm.walk.duration), l: `zu Fuß · ${fmtKm(lm.walk.legs[0].distance || lm.dist * 1.3)}`, sec: lm.walk.duration },
    lm.bike && { k: 'bike', ico: '🚲', v: fmtDur(lm.bike.duration), l: 'Rad / E-Scooter', sec: lm.bike.duration },
    { k: 'uber', ico: '🚕', v: fmtDur(lm.car.duration + 300), l: `Uber/Taxi · ca. ${Math.round(lm.taxi)} €`, sec: lm.car.duration + 300 },
  ].filter(Boolean);
  const best = [...opts].sort((a, b) => a.sec - b.sec)[0];
  // Empfehlung: Gepäck/Nacht/Wetter könnten später einfließen – derzeit: schnellste sinnvolle Option, Fußweg bevorzugt bis 15 Min
  const rec = (lm.walk && lm.walk.duration < 15 * 60) ? 'walk' : best.k;
  // Kurzfassung für die Kopfkarte („Weg zum Ziel“)
  const ro = opts.find(o => o.k === rec);
  // Zeitersparnis gegenüber dem geplanten Rest der Verbindung nennen (z. B. nachts: Taxi statt langer ÖPNV-Kette)
  const it0 = S.active?.itinerary, mainL = it0 && lastMainLeg(it0);
  const planned = mainL ? (new Date(itinEnd(it0)) - new Date(mainL.endTime)) / 1000 : null;
  const gain = planned != null && ro ? Math.round((planned - ro.sec) / 60) : 0;
  if (S.active && ro) { S.active.lmSummary = { ico: ro.ico, text: `${ro.l.split(' · ')[0]} · ${ro.v}${gain >= 10 ? ` (${gain} Min schneller)` : ''}` }; const w = $('#wpLast'); if (w) w.textContent = 'Alternative: ' + S.active.lmSummary.text; }
  c.innerHTML = `<div class="spread"><div class="eyebrow">Vom Bahnhof zum Ziel</div><span class="small muted">ab ${esc(station.name)} · ${fmtT(time)}</span></div>
    <div class="tiles" style="margin-top:10px">${opts.map(o => `<button class="tile ${o.k === rec ? 'best' : ''}" onclick="lastMileAction('${o.k}')"><div class="ico">${o.ico}</div><div class="v">${o.v}</div><div class="l">${esc(o.l)}</div>${o.k === rec ? '<div class="small" style="color:var(--accent2);font-weight:700;margin-top:4px">Empfehlung</div>' : ''}</button>`).join('')}</div>
    ${lm.car.traffic != null ? `<div class="meta">🚗 Auto mit Verkehrslage: ${fmtDur(lm.car.duration)}${lm.car.traffic > 2 ? ` (+${lm.car.traffic} Min Stau)` : ' (frei)'}</div>` : `<div class="meta">🚗 Auto ca. ${fmtDur(lm.car.duration)} ohne Verkehrslage <a href="#" onclick="go('mehr');return false">· HERE-Schlüssel für Stau-Info</a></div>`}
    ${bt ? `<details class="stops" style="margin-top:8px"><summary>ÖPNV-Verbindungen anzeigen (${lm.transit.length})</summary>${lm.transit.slice(0, 3).map(i => `<div class="card flat" style="margin:8px 0">${itinSummary(i)}<div class="meta">${i.legs.filter(isTransit).map(l => `${esc(legName(l))} ${fmtT(l.startTime)} ${esc(l.from.name)}${l.from.track ? ' Gl. ' + esc(l.from.track) : ''} → ${esc(l.to.name)}`).join('<br>')}</div></div>`).join('')}</details>` : ''}`;
  window._lm = { lm, ev };
}
function lastMileAction(k) {
  const { ev } = window._lm || {};
  if (!ev) return;
  const { lm } = window._lm;
  if (k === 'walk') return chooseWalk(ev, lm.from);
  if (k === 'uber') return chooseRide(ev, lm);
  if (k === 'oepnv' && lm.transit.length) return chooseTransit(ev, lm);
  const links = {
    oepnv: [['Apple Karten (ÖPNV)', appleMaps(ev, 'r')], ['Google Maps (ÖPNV)', googleMaps(ev, 'transit')]],
    walk: [['Apple Karten (zu Fuß)', appleMaps(ev, 'w')], ['Google Maps (zu Fuß)', googleMaps(ev, 'walking')]],
    bike: [['Google Maps (Rad)', googleMaps(ev, 'bicycling')], ['Apple Karten', appleMaps(ev, 'w')]],
    uber: [['Uber öffnen (Ziel vorausgefüllt)', uberLink(ev)], ['Bolt öffnen', 'bolt://'], ['FREENOW öffnen', 'freenow://'], ['Taxi Berlin anrufen', 'tel:+4930202020']]
  }[k];
  openSheet(`<h2>${{ oepnv: '🚇 ÖPNV', walk: '🚶 Zu Fuß', bike: '🚲 Rad', uber: '🚕 Uber / Taxi' }[k]}</h2>
    <div class="muted small">Ziel: ${esc(ev.place.name || ev.title)}${ev.place.address ? ', ' + esc(ev.place.address) : ''}</div>
    <div class="list" style="margin-top:12px">${links.map(([t, u]) => `<a class="btn block" href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`).join('')}</div>
    ${k === 'uber' ? '<p class="small muted">Preis ist eine Schätzung nach Berliner Taxitarif. Uber zeigt den echten Preis vor der Buchung.</p>' : ''}
    <button class="btn block ghost" onclick="closeSheet()">Schließen</button>`);
}

let leafletMap = null;
function toggleMap() {
  const w = $('#mapWrap'); w.classList.toggle('hidden');
  if (w.classList.contains('hidden') || !window.L) return;
  if (leafletMap) { leafletMap.remove(); leafletMap = null; }
  leafletMap = L.map('map', { zoomControl: false, attributionControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(leafletMap);
  const it = S.active.itinerary, bounds = [];
  it.legs.forEach(l => {
    if (!l.legGeometry) return;
    const pts = decodePolyline(l.legGeometry.points, l.legGeometry.precision || 6); bounds.push(...pts);
    L.polyline(pts, { color: isTransit(l) ? legColor(l) : '#888', weight: isTransit(l) ? 5 : 3, dashArray: isTransit(l) ? null : '4 6' }).addTo(leafletMap);
  });
  const ev = activeEvent(); L.circleMarker([ev.place.lat, ev.place.lon], { radius: 8, color: '#12a98f', fillOpacity: 1 }).addTo(leafletMap).bindPopup(esc(ev.title));
  bounds.push([ev.place.lat, ev.place.lon]);
  if (GPS.pos) { L.circleMarker([GPS.pos.lat, GPS.pos.lon], { radius: 7, color: '#5b4bf5', fillOpacity: 1 }).addTo(leafletMap).bindPopup('Du'); bounds.push([GPS.pos.lat, GPS.pos.lon]); }
  if (bounds.length) leafletMap.fitBounds(bounds, { padding: [20, 20] });
}

/* Start-Dialog */
function openStart(id) { openStartChoice(id); } // mit Vorplanung: geplante Anreise anbieten
function openStartSearch(id) {
  const ev = S.events.find(e => e.id === id); if (!ev) return;
  openSheet(`<h2>Begleitung nach ${esc(ev.title)}</h2>
    <label class="f">Von wo startest du?</label>
    <div class="seg" id="originSeg"><button class="on" data-o="gps">📍 Mein Standort</button><button data-o="place">🚉 Bahnhof/Ort</button></div>
    <div id="originPlace" class="hidden"><input class="input" id="originInput" placeholder="z. B. Frankfurt (Main) Hbf" autocomplete="off"><div id="originSugg"></div></div>
    <label class="f">Wann?</label>
    <div class="seg" id="whenSeg"><button class="on" data-w="now">Jetzt</button><button data-w="dep">Abfahrt um</button><button data-w="arr" ${ev.start ? '' : 'disabled'}>Ankunft bis</button></div>
    <input class="input hidden" type="datetime-local" id="whenInput" value="${localInputValue(ev.start ? new Date(new Date(ev.start) - 0) : new Date())}">
    <button class="btn primary block" style="margin-top:16px" id="searchBtn">Verbindungen suchen</button>
    <div id="results"></div>`);
  let origin = 'gps', when = 'now', place = null;
  segBind('#originSeg', b => { origin = b.dataset.o; $('#originPlace').classList.toggle('hidden', origin !== 'place'); });
  segBind('#whenSeg', b => { when = b.dataset.w; $('#whenInput').classList.toggle('hidden', when === 'now'); if (when === 'arr') $('#whenInput').value = localInputValue(new Date(ev.start)); });
  placeAutocomplete($('#originInput'), $('#originSugg'), p => place = p, true);
  $('#searchBtn').onclick = async () => {
    const box = $('#results'); box.innerHTML = '<div class="row" style="margin-top:14px"><span class="spinner"></span> Suche Verbindungen…</div>';
    try {
      let o = place;
      if (origin === 'gps') { const p = await getPosOnce(); o = { lat: p.lat, lon: p.lon, name: 'Mein Standort' }; }
      if (!o) { box.innerHTML = '<div class="warnbox">Bitte Startpunkt wählen.</div>'; return; }
      const t = when === 'now' ? new Date() : new Date($('#whenInput').value);
      const its = await planTo(ev, o, t, when === 'arr');
      if (!its.length) { box.innerHTML = '<div class="warnbox">Keine Verbindung gefunden.</div>'; return; }
      window._its = its;
      box.innerHTML = `<label class="f">Wähle deine Verbindung</label><div class="list">${its.slice(0, 6).map((i, k) => `<div class="card flat" style="margin:0;cursor:pointer" onclick="pickItin(${k},'${ev.id}')">${itinSummary(i)}</div>`).join('')}</div>`;
    } catch (e) { box.innerHTML = `<div class="badbox">Fehler: ${esc(e.message)}. ${e.code === 1 ? 'Standortfreigabe erlauben.' : ''}</div>`; }
  };
}
function pickItin(k, id) { closeSheet(); startCompanion(S.events.find(e => e.id === id), structuredClone(window._its[k])); }

/* „Ich sitze schon im Zug“ / Zug wechseln – Vollliste (letzte Option; die smarte Erkennung steckt in ridefind.js) */
function openRideSetupAll(id) {
  const ev = S.events.find(e => e.id === id) || activeEvent(); if (!ev) return;
  openSheet(`<h2>In welchem Zug sitzt du?</h2>
    <div class="muted small">Ich suche Züge an deinem letzten oder nächsten Halt. Danach gleiche ich Verspätung, Strecke und Anschlüsse laufend ab – auch bei Umleitungen (z. B. über Frankfurt statt Köln).</div>
    <label class="f">Zugnummer (optional)</label><input class="input" id="trainNo" placeholder="z. B. ICE 597" value="${esc(ev.train?.name || '')}">
    <label class="f">Halt, an dem du eingestiegen bist / gerade vorbeifährst</label>
    <input class="input" id="stInput" placeholder="Bahnhof suchen" autocomplete="off"><div id="stSugg"></div>
    <button class="btn block" style="margin-top:8px" id="nearBtn">📍 Bahnhöfe in meiner Nähe</button>
    <div id="depList"></div>`);
  const showDeps = async st => {
    const box = $('#depList'); box.innerHTML = '<div class="row" style="margin-top:12px"><span class="spinner"></span> Lade Züge…</div>';
    try {
      // Fernverkehr großzügig zurück (man sitzt evtl. seit Stunden drin), Nahverkehr nur kurz
      const [rf, rn] = await Promise.all([
        stopTimes(st.stopId, new Date(Date.now() - 6 * 3600e3), 150, 'HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,COACH'),
        stopTimes(st.stopId, new Date(Date.now() - 75 * 60e3), 120, 'REGIONAL_FAST_RAIL,REGIONAL_RAIL,SUBURBAN')
      ]);
      const r = { stopTimes: [...(rf.stopTimes || []), ...(rn.stopTimes || [])] };
      const num = ($('#trainNo').value || '').replace(/\D/g, '');
      const seen = new Set(), nowT = Date.now();
      let list = (r.stopTimes || []).filter(x => !seen.has(x.tripId) && seen.add(x.tripId))
        .filter(x => new Date(x.place.departure || x.place.arrival) < nowT + 2 * 3600e3);
      const hit = x => num && `${x.displayName} ${x.tripShortName}`.replace(/\D+/g, ' ').split(' ').includes(num);
      // passende Zugnummer zuerst, sonst die zuletzt abgefahrenen (in denen man vermutlich sitzt) zuerst
      list.sort((a, b) => (hit(b) - hit(a)) || (Math.abs(new Date(a.place.departure || a.place.arrival) - nowT) - Math.abs(new Date(b.place.departure || b.place.arrival) - nowT)));
      list = list.slice(0, 30);
      window._deps = { list, st };
      box.innerHTML = `<label class="f">Züge an ${esc(st.name)}</label><div class="list">${list.map((x, k) => `<div class="item" onclick="pickRide(${k},'${ev.id}')"><div class="ic">${modeIcon(x.mode)}</div><div class="grow"><b>${esc(x.displayName || x.routeShortName)} ${esc(x.tripShortName && !String(x.displayName).includes(x.tripShortName) ? x.tripShortName : '')}</b><div class="small muted ellipsis">→ ${esc(x.headsign)}</div></div><div class="when">${fmtT(x.place.departure || x.place.arrival)}${delayOf(x.place.departure, x.place.scheduledDeparture) > 0 ? `<div class="small" style="color:var(--bad)">+${delayOf(x.place.departure, x.place.scheduledDeparture)}</div>` : ''}</div></div>`).join('') || '<div class="muted">Keine Züge gefunden.</div>'}</div>`;
    } catch (e) { box.innerHTML = `<div class="badbox">${esc(e.message)}</div>`; }
  };
  placeAutocomplete($('#stInput'), $('#stSugg'), p => p.stopId ? showDeps(p) : toast('Bitte einen Bahnhof wählen'), true, true);
  $('#nearBtn').onclick = async () => {
    try {
      const p = await getPosOnce(); const st = await nearestStops(p.lat, p.lon);
      $('#stSugg').innerHTML = `<div class="sugg">${st.map((s, k) => `<button data-k="${k}">🚉 <span class="grow">${esc(s.name)}</span><span class="muted small">${fmtKm(s.dist)}</span></button>`).join('')}</div>`;
      $$('#stSugg button').forEach(b => b.onclick = () => showDeps(st[+b.dataset.k]));
    } catch { toast('Standort nicht verfügbar'); }
  };
}
async function pickRide(k, id) {
  const { list, st } = window._deps, x = list[k], ev = S.events.find(e => e.id === id);
  closeSheet(); toast('Berechne beste Weiterreise…');
  const ride = { tripId: x.tripId, boardStopId: x.place.stopId, boardParentId: x.place.parentId, boardLat: x.place.lat, boardLon: x.place.lon, boardName: st.name, exitStopId: null, ticketTo: ev.train?.to || '' };
  try {
    const res = await buildRideItinerary(ride, ev);
    if (!res.best) { toast('Keine Weiterreise gefunden'); return; }
    if (S.active && S.active.eventId === ev.id) {
      S.active.ride = ride; S.active.itinerary = res.best.itinerary; S.active.notified = {}; save();
      notify(null, 'Zug gewechselt', `${legName(x)} → ${x.headsign}. Neue Ankunft am Ziel: ${fmtT(res.best.itinerary.endTime)} (Ausstieg ${res.best.exit.name}).`, 'ok');
      refreshActive(true);
    } else startCompanion(ev, res.best.itinerary, ride);
  } catch (e) { toast('Fehler: ' + e.message); }
}
function setExit(stopId) { if (!S.active?.ride) return; S.active.ride.exitStopId = stopId; save(); refreshActive(true); }

async function replan() {
  const A = S.active, ev = activeEvent(); if (!A) return;
  toast('Plane neu ab aktueller Position…');
  const now = Date.now(), it = A.itinerary;
  const cur = it.legs.find(l => isTransit(l) && new Date(l.startTime) <= now && new Date(l.endTime) >= now);
  try {
    let origin, t = new Date();
    if (cur && !cur.cancelled) { // im Fahrzeug: ab nächstem Halt neu planen
      const st = (cur.intermediateStops || []).find(s => new Date(s.arrival) > now) || cur.to;
      origin = { lat: st.lat, lon: st.lon, stopId: st.stopId, name: st.name }; t = new Date(st.arrival);
    } else {
      const firstOpen = it.legs.find(l => isTransit(l) && new Date(l.startTime) > now);
      if (GPS.pos) origin = { lat: GPS.pos.lat, lon: GPS.pos.lon, name: 'Mein Standort' };
      else if (firstOpen) origin = { ...firstOpen.from };
      else origin = await getPosOnce();
    }
    const its = await planTo(ev, origin, t, false);
    if (!its.length) { toast('Keine Alternative gefunden'); return; }
    window._its = its.map(i => cur && !cur.cancelled ? { ...i, legs: [{ ...cur, to: origin, endTime: t.toISOString(), intermediateStops: (cur.intermediateStops || []).filter(s => new Date(s.arrival) < t) }, ...i.legs] } : i);
    openSheet(`<h2>Alternativen</h2><div class="muted small">ab ${esc(origin.name || 'Standort')} · ${fmtT(t.toISOString())}</div><div class="list" style="margin-top:12px">${window._its.slice(0, 6).map((i, k) => `<div class="card flat" style="margin:0;cursor:pointer" onclick="adoptItin(${k})">${itinSummary(i)}</div>`).join('')}</div>`);
  } catch (e) { toast('Fehler: ' + e.message); }
}
function adoptItin(k) {
  closeSheet(); const it = structuredClone(window._its[k]);
  Object.assign(S.active, { itinerary: it, ride: null, notified: {}, lastEta: itinEnd(it) }); save();
  feed('Neue Verbindung übernommen', `Ankunft am Ziel ${fmtT(itinEnd(it))}.`, 'ok'); refreshActive(true);
}

/* PLAN (Termine) */
function renderPlan() {
  const el = $('#view-plan');
  const seg = `<div class="seg" style="margin-top:6px"><button class="${planTab === 'kommend' ? 'on' : ''}" onclick="planTab='kommend';renderPlan()">Termine</button><button class="${planTab === 'archiv' ? 'on' : ''}" onclick="planTab='archiv';renderPlan()">🗄️ Archiv (${S.archive.length})</button></div>`;
  if (planTab === 'archiv') { el.innerHTML = seg + renderArchive(); return; }
  el.innerHTML = seg; renderPlanList(el);
}
function renderPlanList(el) {
  const evs = [...S.events].sort((a, b) => (a.start ? new Date(a.start) : 0) - (b.start ? new Date(b.start) : 0));
  let h = `<div class="row wrap" style="margin:8px 0"><button class="btn primary" onclick="openAdd()">＋ Neu</button><button class="btn" onclick="openImport('text')">✉️ Aus E-Mail</button><button class="btn" onclick="openImport('ics')">📆 Kalender</button><button class="btn" onclick="openImport('image')">📄 Datei / Foto</button></div>`;
  if (!evs.length) h += `<div class="empty"><div class="ico">📅</div>Noch keine Termine.</div>`;
  let lastDay = null;
  for (const e of evs) {
    const dk = e.start ? dayKey(e.start) : 'offen';
    if (dk !== lastDay) { h += `<div class="daylabel">${e.start ? fmtD(e.start) : 'Ohne feste Zeit'}</div>`; lastDay = dk; }
    h += `<div class="item" onclick="openEvent('${e.id}')" style="${e.done ? 'opacity:.55' : ''}"><div class="ic">${KIND[e.kind]?.ico || '📍'}</div><div class="grow"><b class="ellipsis" style="display:block">${esc(e.title)}</b><div class="small muted ellipsis">${esc(e.place?.address || e.place?.name || '')}</div>${e.plan ? `<div class="small ellipsis" style="color:var(--accent)">${prePlanLine(e)}</div>` : ''}</div><div class="when">${e.start ? fmtT(e.start) : '—'}${S.active?.eventId === e.id ? '<div class="small" style="color:var(--ok)">● live</div>' : e.done ? `<div class="small" style="color:var(--accent)" onclick="event.stopPropagation();askArchive('${e.id}')">archivieren</div>` : ''}</div></div>`;
  }
  el.insertAdjacentHTML('beforeend', h);
}
function openEvent(id) {
  const e = S.events.find(x => x.id === id);
  openSheet(`<h2>${KIND[e.kind]?.ico || ''} ${esc(e.title)}</h2>
    <div class="muted">${esc(e.place?.name || '')}${e.place?.address ? '<br>' + esc(e.place.address) : ''}</div>
    <div style="margin-top:8px">${e.start ? `${fmtD(e.start)}, ${fmtT(e.start)}${e.end ? ' – ' + fmtT(e.end) : ''}` : 'Zeit offen'}${e.checkIn ? ` · Check-in ab ${esc(e.checkIn)}` : ''}</div>
    ${e.train?.name ? `<div class="meta">🚄 ${esc(e.train.name)}${e.train.from ? ' ab ' + esc(e.train.from) : ''}${e.train.dep ? ' ' + esc(e.train.dep) : ''}</div>` : ''}
    ${e.notes ? `<div class="card flat small" style="white-space:pre-wrap">${esc(e.notes)}</div>` : ''}
    <div style="margin-top:12px">${prePlanCard(e)}</div>
    <div class="list" style="margin-top:14px">
      <button class="btn primary block" onclick="closeSheet();openStart('${e.id}')">▶︎ Begleitung starten</button>
      <button class="btn block" onclick="closeSheet();openRideSetup('${e.id}')">🚄 Ich sitze schon im Zug</button>
      <button class="btn block" onclick="openAdd('${e.id}')">✏️ Bearbeiten</button>
      <button class="btn block" onclick="exportICS('${e.id}')">📆 In Kalender exportieren (.ics)</button>
      ${e.kind !== 'hotel' ? `<button class="btn block" onclick="closeSheet();openHotelStep('${e.id}')">🏨 Hotel suchen</button>` : e.booking && e.booking.status !== 'gebucht' ? `<button class="btn block" onclick="S.pendingBooking={evId:'${e.id}',via:'${e.booking.via === 'vorgemerkt' ? 'Booking.com' : e.booking.via}',at:0};closeSheet();checkBookingReturn()">✅ Als gebucht markieren</button>` : ''}
      <button class="btn block" onclick="window._nextAfter='${e.id}';closeSheet();openAdd()">➕ Nächste Etappe ab hier planen</button>
      <button class="btn block" onclick="askArchive('${e.id}')">🗄️ Reise archivieren</button>
      <button class="btn block danger" onclick="delEvent('${e.id}')">Löschen</button>
    </div>`);
}
function delEvent(id) { if (!confirm('Termin löschen?')) return; S.events = S.events.filter(e => e.id !== id); if (S.active?.eventId === id) S.active = null; save(); closeSheet(); render(); }

/* Eingabe: Schnell-Eingabe */
function openAdd(editId, prefill = null) {
  const e = editId ? { ...S.events.find(x => x.id === editId), ...(prefill || {}) } : { kind: 'hotel', title: '', place: null, start: null, ...(prefill || {}) };
  let place = e.place, kind = e.kind;
  // Für den Absprung zu Google: Formular sichern, damit es bei der Rückkehr wieder da ist
  window._lookupResume = { type: 'add', data: () => ({ editId, form: { kind, place, title: $('#titleInput')?.value || '', start: $('#startInput')?.value ? new Date($('#startInput').value).toISOString() : null, arriveBy: $('#arrByChk')?.checked ? 'x' : null, checkIn: $('#checkIn')?.value || '', notes: $('#notesInput')?.value || '' } }) };
  openSheet(`<h2>${editId ? 'Bearbeiten' : 'Neues Ziel'}</h2>
    ${editId ? '' : `<div class="bigchoices" style="margin-bottom:6px">
      <button class="bigchoice" onclick="openImport('text')"><div class="ico">✉️</div><b>Aus E-Mail</b><span>Text einfügen</span></button>
      <button class="bigchoice" onclick="openImport('image')"><div class="ico">📄</div><b>Datei / Foto</b><span>Einladung, Agenda, Ticket</span></button>
      <button class="bigchoice" onclick="openImport('ics')"><div class="ico">📆</div><b>Kalender</b><span>.ics-Datei</span></button>
      <button class="bigchoice" onclick="pasteClipboard()"><div class="ico">📋</div><b>Zwischenablage</b><span>Kopiertes übernehmen</span></button>
      <button class="bigchoice" onclick="openExpense()"><div class="ico">🧾</div><b>Beleg / Kosten</b><span>Ticket, Hotel, Quittung</span></button>
      <button class="bigchoice" onclick="openDrive()"><div class="ico">🚗</div><b>Autofahrt</b><span>Kilometer erfassen</span></button></div>
      <div class="eyebrow" style="margin-top:14px">oder schnell eintippen</div>`}
    <label class="f">Art</label>
    <div class="chips" id="kindChips">${Object.entries(KIND).map(([k, v]) => `<button class="chip ${k === kind ? 'on' : ''}" data-k="${k}">${v.ico} ${v.label}</button>`).join('')}</div>
    <label class="f">Wohin? (Hotel, Adresse, Bahnhof, Firma…)</label>
    <input class="input" id="placeInput" placeholder="z. B. Hotelname, Adresse oder Firma" value="${esc(e.place?.name || '')}" autocomplete="off">
    <div id="placeSugg"></div>
    ${S.favorites.length ? `<div class="chips" style="margin-top:8px">${S.favorites.map((f, k) => `<button class="chip" data-fav="${k}">⭐ ${esc(f.name)}</button>`).join('')}</div>` : ''}
    <label class="f">Titel</label><input class="input" id="titleInput" value="${esc(e.title)}" placeholder="wird aus dem Ort übernommen">
    <label class="f">Wann musst du dort sein?</label>
    <div class="chips" id="timeChips"><button class="chip" data-t="open">Offen</button><button class="chip" data-t="1h">in 1 h</button><button class="chip" data-t="eve">heute 20:00</button><button class="chip" data-t="tm9">morgen 9:00</button></div>
    <input class="input" style="margin-top:8px" type="datetime-local" id="startInput" value="${e.start ? localInputValue(new Date(e.start)) : ''}">
    <label class="row small" style="margin-top:8px"><input type="checkbox" id="arrByChk" ${e.arriveBy ? 'checked' : ''}> Das ist die Zeit, zu der ich <b>spätestens dort</b> sein muss</label>
    <div id="checkWrap" class="${kind === 'hotel' ? '' : 'hidden'}"><label class="f">Check-in ab</label><input class="input" id="checkIn" placeholder="15:00" value="${esc(e.checkIn || '')}"></div>
    <label class="f">Notizen (Buchungsnr., Ansprechpartner…)</label><textarea class="input" id="notesInput" style="min-height:70px">${esc(e.notes || '')}</textarea>
    <label class="row small" style="margin-top:10px"><input type="checkbox" id="favChk"> Als Favorit merken</label>
    <button class="btn primary block" style="margin-top:14px" id="saveBtn">Speichern</button>`);
  $$('#kindChips .chip').forEach(b => b.onclick = () => { kind = b.dataset.k; $$('#kindChips .chip').forEach(x => x.classList.toggle('on', x === b)); $('#checkWrap').classList.toggle('hidden', kind !== 'hotel'); });
  placeAutocomplete($('#placeInput'), $('#placeSugg'), p => { place = p; if (!$('#titleInput').value) $('#titleInput').value = p.name; if (p.type === 'HOTEL' || /hotel|motel|hostel|inn\b/i.test(p.name)) { kind = 'hotel'; $$('#kindChips .chip').forEach(x => x.classList.toggle('on', x.dataset.k === 'hotel')); $('#checkWrap').classList.remove('hidden'); } });
  $$('[data-fav]').forEach(b => b.onclick = () => { place = S.favorites[+b.dataset.fav]; $('#placeInput').value = place.name; $('#titleInput').value ||= place.name; });
  $$('#timeChips .chip').forEach(b => b.onclick = () => {
    const d = new Date();
    if (b.dataset.t === 'open') { $('#startInput').value = ''; return; }
    if (b.dataset.t === '1h') d.setHours(d.getHours() + 1);
    if (b.dataset.t === 'eve') d.setHours(20, 0, 0, 0);
    if (b.dataset.t === 'tm9') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
    $('#startInput').value = localInputValue(d);
  });
  $('#saveBtn').onclick = async () => {
    if (!place && $('#placeInput').value.trim()) { const g = await geocode($('#placeInput').value.trim()); place = g[0]; }
    if (!place) { toast('Bitte einen Ort wählen'); return; }
    const data = { kind, place, title: $('#titleInput').value.trim() || place.name, start: $('#startInput').value ? new Date($('#startInput').value).toISOString() : null, checkIn: kind === 'hotel' ? $('#checkIn').value.trim() : '', notes: $('#notesInput').value.trim() };
    data.arriveBy = $('#arrByChk').checked && data.start ? data.start : null;
    if (data.title && place && normKey(data.title) !== normKey(place.name) && place.type !== 'STOP') rememberPlace(data.title, place); // „KOM27“ → Adresse merken
    const newId = uid();
    if (editId) Object.assign(e, data); else S.events.push({ id: newId, ...data });
    if ($('#favChk').checked && !S.favorites.some(f => f.name === place.name)) S.favorites.push(place);
    save(); closeSheet(); toast('Gespeichert ✓'); render();
    // neuer Termin in der Zukunft → direkt anbieten, die Anreise vorzuplanen (optional)
    if (!editId) {
      const ne = S.events.find(x => x.id === newId);
      // Folgeetappe einer laufenden/gebuchten Reise? → Anfahrt ab dort anbieten; sonst Termin zum Vorplanen öffnen
      if (ne.kind !== 'hotel' && ne.start && findAnchor(ne)) setTimeout(() => offerFollowUp(ne), 350);
      else if (data.start && new Date(data.start) - Date.now() > 3600e3) setTimeout(() => openEvent(newId), 350);
    }
  };
}
function placeAutocomplete(input, box, onPick, focus = false, stopsOnly = false) {
  if (!input) return; let t, missed = null; // „missed“: Name ohne Treffer (z. B. KOM27) – wird mit der danach gewählten Adresse verknüpft
  input.oninput = () => {
    clearTimeout(t); const q = input.value.trim(); if (q.length < 3) { box.innerHTML = ''; return; }
    t = setTimeout(async () => {
      box.innerHTML = '<div class="row small muted" style="margin-top:8px"><span class="spinner"></span> suche…</div>';
      let r = await geocode(q); if (stopsOnly) r = r.filter(x => x.type === 'STOP');
      // ähnlich klingende Treffer weit weg (z. B. „KOM2“ in Frankreich für „KOM27“) gelten als „nicht gefunden“
      const ctx = geoContext(), nq = normKey(q).split(' ')[0];
      r = r.filter(x => x.known || normKey(`${x.name} ${x.address || ''}`).includes(nq) || !ctx || haversine(ctx, x) < 300000);
      const city = ctx?.city || '';
      const web = `https://www.google.com/maps/search/?${qs({ api: 1, query: city && !q.toLowerCase().includes(city.toLowerCase()) ? `${q} ${city}` : q })}`;
      if (!r.length && !stopsOnly) missed = q;
      box.innerHTML = (r.length ? `<div class="sugg">${r.slice(0, 7).map((x, k) => `<button data-k="${k}"><span>${x.known ? '⭐' : x.type === 'STOP' ? '🚉' : x.type === 'HOTEL' ? '🏨' : '📍'}</span><span class="grow"><b>${esc(x.name)}</b><div class="small muted">${esc(x.address || '')}${x.src ? ' · ' + esc(x.src) : ''}</div></span></button>`).join('')}</div>`
        : `<div class="warnbox">„${esc(q)}“ ist in den freien Kartendaten nicht verzeichnet. Such die Adresse in Google Maps, tippe dort auf <b>Teilen → Kopieren</b> (oder kopiere die Adresse) und komm zurück – ich übernehme sie und merke mir „${esc(q)}“.</div>`)
        + (stopsOnly ? '' : `<div class="row wrap" style="gap:6px;margin-top:6px">${!r.length ? '<button class="btn sm primary" data-paste>📋 Adresse einfügen</button>' : ''}<a class="btn ghost sm" style="padding-left:0" target="_blank" rel="noopener" href="${esc(web)}" data-web>🔎 ${r.length ? 'Nicht dabei? ' : ''}In Google Maps suchen</a></div>`);
      $$('button[data-k]', box).forEach(b => b.onclick = () => pick(r[+b.dataset.k]));
      const w = $('[data-web]', box); if (w) w.onclick = () => saveLookup(missed || q);
      const pb = $('[data-paste]', box); if (pb) pb.onclick = async () => {
        try { applyPasted(await navigator.clipboard.readText()); } catch { toast('Bitte lange ins Feld tippen → „Einsetzen“'); input.focus(); }
      };
    }, 350);
  };
  const pick = p => {
    if (missed && normKey(missed) !== normKey(p.name) && !stopsOnly) { p = { ...p, name: missed, address: p.address || p.name }; rememberPlace(missed, p); toast(`Gemerkt: ${missed} = ${p.address}`); missed = null; }
    S.pendingLookup = null; save();
    input.value = p.name; box.innerHTML = ''; onPick(p);
  };
  // Aus Google Maps kopierter Text (Name, Adresse, Link) → Ort erkennen und direkt übernehmen
  const applyPasted = async text => {
    const c = parseCopiedPlace(text || '');
    if (c.shortOnly) { toast('Nur ein Kurzlink – bitte in Google Maps die Adresse kopieren'); return; }
    if (!c.address && !c.coords) { toast('Keine Adresse in der Zwischenablage gefunden'); return; }
    box.innerHTML = '<div class="row small muted" style="margin-top:8px"><span class="spinner"></span> übernehme Adresse…</div>';
    let p = null;
    if (c.coords) { const a = await revGeo(c.coords); p = { lat: c.coords.lat, lon: c.coords.lon, name: c.name || a || 'Ort', address: c.address || a, type: 'PLACE' }; }
    else { p = (await geocode(c.address)).find(x => x.type !== 'STOP'); if (p) p = { ...p, address: c.address }; }
    if (!p) { input.value = c.address; input.dispatchEvent(new Event('input')); return; }
    if (!missed && c.name && normKey(c.name) !== normKey(p.name)) p.name = c.name;
    pick(p);
  };
  input.addEventListener('paste', e => {
    const t = e.clipboardData?.getData('text') || '';
    if (/\n|goo\.gl|google\.|maps\.app/.test(t)) { e.preventDefault(); if (!missed && input.value.trim().length > 2) missed = input.value.trim(); applyPasted(t); }
  });
  if (focus) setTimeout(() => input.focus(), 300);
}
/* Google-Maps-Text auswerten: „Name\nStraße 1, 12345 Ort\nhttps://maps…“ oder Link mit Koordinaten */
function parseCopiedPlace(t) {
  const txt = String(t).trim();
  const lines = txt.split(/\n+/).map(s => s.trim()).filter(Boolean).filter(l => !/^https?:\/\//.test(l));
  const addr = lines.find(l => /\b\d{5}\s+\S/.test(l)) || lines.find(l => /\d/.test(l) && /(str\.|straße|strasse|weg|platz|allee|damm|ring|ufer|gasse|chaussee)/i.test(l)) || (lines.length === 1 ? lines[0] : null);
  const m = txt.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/) || txt.match(/[?&](?:q|ll|query|destination)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/);
  const urlName = (txt.match(/\/maps\/place\/([^/@?]+)/) || [])[1];
  const name = lines.length > 1 && lines[0] !== addr ? lines[0] : urlName ? decodeURIComponent(urlName.replace(/\+/g, ' ')) : null;
  return { address: addr, name, coords: m ? { lat: +m[1], lon: +m[2] } : null, shortOnly: /maps\.app\.goo\.gl|goo\.gl\/maps/.test(txt) && !addr && !m };
}
/* Absprung zu Google: aktuellen Planungsstand sichern … */
function saveLookup(q) {
  const r = window._lookupResume; if (!r) return;
  S.pendingLookup = { q, at: Date.now(), type: r.type, data: typeof r.data === 'function' ? r.data() : r.data }; save();
}
/* … und bei der Rückkehr die Planung wieder öffnen */
function resumeLookup() {
  const L = S.pendingLookup; if (!L || document.hidden) return;
  if (Date.now() - L.at > 3 * 3600e3) { S.pendingLookup = null; save(); return; }
  if (Date.now() - L.at < 1500) return; // nicht direkt beim Antippen des Links
  const open = !$('#sheet').classList.contains('hidden');
  if (L.resumed && !open) { S.pendingLookup = null; save(); return; } // schon wiederhergestellt und dann geschlossen
  if (open && $('#placeInput, [data-pq]')) { L.resumed = true; save(); return; } // Formular ist noch offen (App lief weiter)
  L.resumed = true; save();
  if (L.type === 'import' && L.data?.drafts) { openImport('text'); reviewDrafts(L.data.drafts, true); }
  else if (L.type === 'add' && L.data) {
    const f = L.data.form || {};
    openAdd(L.data.editId || null, { ...f, arriveBy: f.arriveBy ? f.start : null });
    const inp = $('#placeInput');
    if (inp && L.q) { inp.value = L.q; inp.dispatchEvent(new Event('input')); }
    toast('↩︎ Zurück aus Google – Adresse kopiert? Tippe auf „📋 Adresse einfügen“', 5000);
  }
}
document.addEventListener('visibilitychange', () => setTimeout(resumeLookup, 600));
window.addEventListener('pageshow', () => setTimeout(resumeLookup, 800));

/* ───────────── Import: E-Mail-Text, Screenshot, .ics ───────────── */
function openImport(mode) {
  const body = {
    text: `<h2>✉️ Aus E-Mail übernehmen</h2><div class="muted small">Buchungsbestätigung (DB, Hotel, Termin) hier einfügen. Ich erkenne Zug, Zeiten, Bahnhöfe, Hotel & Adresse.</div>
      <textarea class="input" id="impText" style="margin-top:10px" placeholder="E-Mail-Text einfügen…"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn" onclick="pasteClipboard(true)">📋 Einfügen</button><button class="btn primary grow" id="impGo">Erkennen</button></div>`,
    image: `<h2>📄 Datei oder Foto</h2><div class="muted small">Einladung, Tagesordnung, Ticket, Buchung oder Screenshot – als PDF, Foto, Kalenderdatei oder Text. Ich übernehme Titel, Datum, Uhrzeit und Ort. ${S.settings.claudeKey ? 'Claude liest die Datei aus.' : ''}</div>
      <input class="input" type="file" accept="image/*,application/pdf,.pdf,.ics,text/calendar,.txt,.eml,text/plain" id="impImg" style="margin-top:10px">`,
    ics: `<h2>📆 Kalender importieren</h2><div class="muted small">.ics-Datei wählen (z. B. aus Mail-Anhang, Outlook/Google-Export oder iOS „Teilen → In Dateien sichern“).</div>
      <input class="input" type="file" accept=".ics,text/calendar" id="impIcs" style="margin-top:10px">`
  }[mode];
  openSheet(body + '<div id="impOut"></div>');
  if (mode === 'text') $('#impGo').onclick = () => runExtract({ text: $('#impText').value });
  if (mode === 'image') $('#impImg').onchange = e => e.target.files[0] && importFile(e.target.files[0]);
  if (mode === 'ics') $('#impIcs').onchange = async e => { const f = e.target.files[0]; if (f) reviewDrafts(parseICS(await f.text())); };
}
async function pasteClipboard(intoField) {
  try {
    const t = await navigator.clipboard.readText();
    if (intoField && $('#impText')) { $('#impText').value = t; return; }
    openImport('text'); $('#impText').value = t; runExtract({ text: t });
  } catch { if (!intoField) openImport('text'); toast('Bitte lange tippen → „Einsetzen“'); }
}
/* Beliebige Datei: PDF (Einladung/Tagesordnung/Ticket), Foto, .ics, Text/E-Mail */
async function importFile(f) {
  const name = (f.name || '').toLowerCase();
  if (/\.ics$/.test(name) || f.type === 'text/calendar') return reviewDrafts(parseICS(await f.text()));
  if (/\.(txt|eml)$/.test(name) || f.type.startsWith('text/')) return runExtract({ text: await f.text() });
  if (f.type === 'application/pdf' || /\.pdf$/.test(name)) return runExtract({ pdf: f });
  return runExtract({ image: f });
}
async function runExtract({ text, image, pdf }) {
  const out = $('#impOut'); out.innerHTML = '<div class="row" style="margin-top:12px"><span class="spinner"></span> Lese Daten aus…</div>';
  try {
    let drafts = [];
    if (S.settings.claudeKey) {
      try { drafts = await claudeExtract(text, image, pdf); } catch (e) { console.warn(e); toast('Claude nicht erreichbar – nutze lokale Erkennung'); }
    }
    if (!drafts.length) {
      if (pdf) text = await pdfText(pdf);
      if (image) text = await ocr(image, out);
      drafts = ruleExtract(text || '');
    }
    if (!drafts.length) { out.innerHTML = '<div class="warnbox">Nichts erkannt. Du kannst das Ziel auch schnell selbst eintippen.</div><button class="btn block" onclick="openAdd()">Schnell-Eingabe</button>'; return; }
    reviewDrafts(drafts);
  } catch (e) { out.innerHTML = `<div class="badbox">${esc(e.message)}</div>`; }
}
async function ocr(file, out) {
  if (!window.Tesseract) {
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  const r = await Tesseract.recognize(file, 'deu', { logger: m => { if (m.status === 'recognizing text' && out) out.innerHTML = `<div class="row" style="margin-top:12px"><span class="spinner"></span> Texterkennung ${Math.round(m.progress * 100)} %</div>`; } });
  return r.data.text;
}
async function claudeExtract(text, image, pdf) {
  const sys = `Du extrahierst Reisedaten und Termine aus E-Mails, Einladungen, Tagesordnungen, Tickets, Kalendern und Screenshots. Bei Einladungen/Tagesordnungen: kind=termin, title=Name der Veranstaltung, placeName/address=Veranstaltungsort (inkl. Raum in notes), start=Beginn, end=Ende.`;
  if (pdf) {
    const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(pdf); });
    const ans = await claude([{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'Extrahiere die Termine/Reisedaten.' }], sys + EXTRACT_JSON());
    return mapClaudeEvents(ans);
  }
  return claudeExtractInner(text, image, sys);
}
const EXTRACT_JSON = () => ` Antworte NUR mit JSON: {"events":[{"kind":"hotel|termin|zug|ort","title":"","placeName":"","address":"","start":"ISO 8601 mit Zeitzone Europe/Berlin oder null","end":null,"checkIn":"HH:MM oder ''","trainName":"z.B. ICE 597 oder ''","fromStation":"","toStation":"","dep":"HH:MM oder ''","notes":"Buchungsnummer, Raum, Ansprechpartner etc."}]}. Heute ist ${new Date().toISOString().slice(0, 10)}. Für eine Zugfahrt: kind=zug, placeName=Zielbahnhof, start=Ankunftszeit.`;
function mapClaudeEvents(ans) {
  const j = JSON.parse(ans.slice(ans.indexOf('{'), ans.lastIndexOf('}') + 1));
  return (j.events || []).map(x => ({ kind: x.kind || 'ort', title: x.title || x.placeName, query: [x.placeName, x.address].filter(Boolean).join(', '), start: x.start || null, end: x.end || null, checkIn: x.checkIn || '', notes: x.notes || '', train: x.trainName ? { name: x.trainName, from: x.fromStation, to: x.toStation, dep: x.dep } : null }));
}
async function claudeExtractInner(text, image, sysBase) {
  const sys = sysBase + ` Du extrahierst Reisedaten aus E-Mails, Tickets, Kalendern und Screenshots. Antworte NUR mit JSON: {"events":[{"kind":"hotel|termin|zug|ort","title":"","placeName":"","address":"","start":"ISO 8601 mit Zeitzone Europe/Berlin oder null","end":null,"checkIn":"HH:MM oder ''","trainName":"z.B. ICE 597 oder ''","fromStation":"","toStation":"","dep":"HH:MM oder ''","notes":"Buchungsnummer, Sitzplatz, Wagen etc."}]}. Heute ist ${new Date().toISOString().slice(0, 10)}. Für eine Zugfahrt: kind=zug, placeName=Zielbahnhof, start=Ankunftszeit.`;
  const content = [];
  if (image) {
    const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(image); });
    content.push({ type: 'image', source: { type: 'base64', media_type: image.type || 'image/jpeg', data: b64 } });
  }
  content.push({ type: 'text', text: text ? `Text:\n${text}` : 'Extrahiere die Reisedaten aus dem Bild.' });
  return mapClaudeEvents(await claude(content, sys));
}
/* Einladungen & Tagesordnungen (ohne KI): Titel, Datum, Beginn/Ende, Ort, Raum */
const MONTHS = { januar: 1, jan: 1, februar: 2, feb: 2, märz: 3, maerz: 3, mär: 3, april: 4, apr: 4, mai: 5, juni: 6, jun: 6, juli: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12 };
function parseGermanDate(txt) {
  let m = txt.match(/(\d{1,2})\.\s*(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|jan|feb|mär|apr|jun|jul|aug|sept?|okt|nov|dez)\.?\s*(\d{4})?/i);
  if (m) return new Date(+(m[3] || new Date().getFullYear()), MONTHS[m[2].toLowerCase()] - 1, +m[1]);
  m = txt.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/);
  if (m) return new Date(+(m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : new Date().getFullYear()), +m[2] - 1, +m[1]);
  return null;
}
function agendaExtract(txt) {
  const isAgenda = /(einladung|tagesordnung|agenda|sitzung|besprechung|meeting|workshop|konferenz|tagung|seminar|veranstaltung|termin|treffen|kick-?off|schulung)/i.test(txt);
  const lineAfter = re => { const m = txt.match(re); return m ? m[1].trim().replace(/\s{2,}/g, ' ') : ''; };
  let place = lineAfter(/(?:^|\n)\s*(?:veranstaltungsort|tagungsort|sitzungsort|ort|adresse|location|wo|anschrift)\s*[:：]\s*([^\n]+(?:\n\s*\d{5}[^\n]*)?)/i);
  const addr = txt.match(/([A-ZÄÖÜ][\wäöüß.\- ]{2,40}?\s\d{1,4}\s?[a-z]?)\s*,?\s*\n?\s*(\d{5})\s+([A-ZÄÖÜ][\wäöüß\- ]+)/);
  if (!place && addr) place = `${addr[1]}, ${addr[2]} ${addr[3]}`;
  if (!isAgenda || !place) return null;
  const room = lineAfter(/(?:raum|saal|etage|gebäude)\s*[:：]?\s*([^\n,]{1,40})/i);
  const d = parseGermanDate(txt) || new Date();
  // Uhrzeiten – aber keine Datumsteile wie „18.11.“
  const T = '(\\d{1,2})[:.](\\d{2})(?![.\\d])';
  const at = m => { if (!m) return null; const s = new Date(d); s.setHours(+m[1], +m[2], 0, 0); return s.toISOString(); };
  const mStart = txt.match(new RegExp(`(?:beginn|start|uhrzeit|zeit|ab)\\s*[:：]?\\s*(?:um\\s*)?${T}`, 'i')) || txt.match(new RegExp(`(?<![\\d.])${T}\\s*uhr`, 'i')) || txt.match(new RegExp(`(?<![\\d.])${T}`));
  const mEnd = txt.match(new RegExp(`${T}\\s*(?:uhr)?\\s*(?:-|–|bis)\\s*${T}`, 'i'));
  const mBy = txt.match(new RegExp(`(?:spätestens|einlass bis|bitte bis|ankunft bis)\\s*(?:um\\s*)?${T}`, 'i'));
  let start = at(mStart) || at([0, 9, 0]), end = mEnd ? at([0, mEnd[3], mEnd[4]]) : null;
  const arriveBy = at(mBy);
  const title = lineAfter(/(?:betreff|thema|titel)\s*[:：]\s*([^\n]+)/i)
    || lineAfter(/(einladung\s+(?:zur|zum|zu)\s+[^\n]+)/i)
    || lineAfter(/((?:sitzung|workshop|konferenz|tagung|seminar|meeting|besprechung)[^\n]{0,60})/i)
    || txt.split('\n').map(s => s.trim()).find(s => s.length > 4) || 'Termin';
  const contact = lineAfter(/(?:ansprechpartner(?:in)?|kontakt)\s*[:：]\s*([^\n]+)/i);
  return { kind: 'termin', title: title.replace(/^einladung\s+(zur|zum|zu)\s+/i, '').replace(/^\w/, c => c.toUpperCase()).slice(0, 80), query: place.replace(/\n/g, ', '), start, end, notes: [room && 'Raum: ' + room, contact && 'Kontakt: ' + contact].filter(Boolean).join('\n'), context: txt.slice(0, 2000), arriveBy };
}
/* Regelbasierte Erkennung (ohne KI) */
function ruleExtract(t) {
  const drafts = [], txt = t.replace(/\r/g, '');
  const date = (txt.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/) || []);
  const baseDate = date.length ? new Date(+(date[3].length === 2 ? '20' + date[3] : date[3]), +date[2] - 1, +date[1]) : new Date();
  const at = hm => { if (!hm) return null; const [h, m] = hm.split(/[:.]/).map(Number); const d = new Date(baseDate); d.setHours(h, m, 0, 0); return d.toISOString(); };
  // Zug
  const tr = txt.match(/\b(ICE|IC|EC|ECE|RE|RB|IRE|FLX|NJ|EN|TGV|RJX?)\s?(\d{1,5})\b/);
  const from = txt.match(/(?:^|\n|\s)(?:ab|von|Abfahrt)[:\s]+([A-ZÄÖÜ][\wÄÖÜäöüß .()\-/]+?)\s+(?:\(?\d{1,2}[:.]\d{2})/i);
  const to = txt.match(/(?:^|\n|\s)(?:an|nach|Ankunft)[:\s]+([A-ZÄÖÜ][\wÄÖÜäöüß .()\-/]+?)\s+(?:\(?\d{1,2}[:.]\d{2})/i);
  const times = [...txt.matchAll(/\b(\d{1,2}[:.]\d{2})\s*(?:Uhr)?/g)].map(m => m[1]);
  if (tr || (from && to)) {
    const toTime = txt.match(/(?:an|Ankunft)[:\s]+[^\n]*?(\d{1,2}[:.]\d{2})/i)?.[1] || times[1];
    drafts.push({ kind: 'zug', title: `${tr ? tr[1] + ' ' + tr[2] : 'Zug'} nach ${to ? to[1].trim() : '?'}`, query: to ? to[1].trim() : '', start: at(toTime), train: { name: tr ? `${tr[1]} ${tr[2]}` : '', from: from?.[1]?.trim(), to: to?.[1]?.trim(), dep: txt.match(/(?:ab|Abfahrt)[:\s]+[^\n]*?(\d{1,2}[:.]\d{2})/i)?.[1] || times[0] }, notes: (txt.match(/(Auftragsnummer|Buchungsnummer|Wagen|Platz|Sitzplatz)[:\s]+[^\n]+/gi) || []).join('\n') });
  }
  // Hotel / Adresse
  const hotel = txt.match(/((?:Motel One|Hotel|Hostel|Ibis|Premier Inn|Holiday Inn|NH|Meininger|B&B Hotel|Mercure|Novotel|Radisson|Leonardo|Hampton|Moxy|Adina|Steigenberger|Maritim|Best Western|Hilton|Marriott)[^\n,]{0,40})/i);
  const addr = txt.match(/([A-ZÄÖÜ][\wäöüß.\- ]{2,40}?\s\d{1,4}\s?[a-z]?)\s*,?\s*\n?\s*(\d{5})\s+([A-ZÄÖÜ][\wäöüß\- ]+)/);
  const ci = txt.match(/check-?\s?in[^\d\n]{0,25}(\d{1,2}[:.]\d{2})/i);
  if (hotel || addr) {
    const nights = txt.match(/(?:Anreise|Check-?in)[:\s]+(\d{1,2}\.\d{1,2}\.\d{2,4})/i);
    let start = null;
    if (nights) { const [d, m, y] = nights[1].split('.'); const dd = new Date(+(y.length === 2 ? '20' + y : y), +m - 1, +d, 20, 0); start = dd.toISOString(); }
    drafts.push({ kind: hotel ? 'hotel' : 'termin', title: hotel ? hotel[1].trim() : 'Termin', query: [hotel?.[1]?.trim(), addr ? `${addr[1]}, ${addr[2]} ${addr[3]}` : ''].filter(Boolean).join(', '), start, checkIn: ci ? ci[1].replace('.', ':') : '', notes: (txt.match(/(Reservierungsnummer|Buchungsnummer|Bestätigungsnummer|Confirmation)[^\n]+/gi) || []).join('\n') });
  }
  // Einladung / Tagesordnung / Termin
  const ag = agendaExtract(txt);
  if (ag && !drafts.some(d => d.kind === 'hotel' && d.query && ag.query && d.query.includes(ag.query.split(',')[0]))) {
    // generischen „Termin“-Entwurf mit derselben Adresse durch den genaueren ersetzen
    for (let i = drafts.length - 1; i >= 0; i--) if (drafts[i].kind === 'termin' && drafts[i].title === 'Termin') drafts.splice(i, 1);
    drafts.push(ag);
  }
  if (!drafts.length && times.length && addr) drafts.push({ kind: 'termin', title: txt.split('\n').find(l => l.trim().length > 3)?.trim().slice(0, 60) || 'Termin', query: `${addr[1]}, ${addr[2]} ${addr[3]}`, start: at(times[0]) });
  return drafts;
}
function parseICS(src) {
  const lines = src.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = []; let cur = null;
  const dt = v => {
    const m = v.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/); if (!m) return null;
    return m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0))).toISOString() : new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).toISOString();
  };
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = {};
    else if (l === 'END:VEVENT' && cur) { out.push(cur); cur = null; }
    else if (cur) {
      const i = l.indexOf(':'); const k = l.slice(0, i).split(';')[0]; const v = l.slice(i + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';');
      if (k === 'SUMMARY') cur.title = v; if (k === 'LOCATION') cur.query = v; if (k === 'DTSTART') cur.start = dt(v); if (k === 'DTEND') cur.end = dt(v); if (k === 'DESCRIPTION') cur.notes = v;
    }
  }
  return out.filter(e => e.start && new Date(e.start) > Date.now() - 86400e3).map(e => ({ kind: /hotel|motel|check-?in/i.test(e.title + e.query) ? 'hotel' : /\b(ICE|IC|RE|Zug)\b/.test(e.title) ? 'zug' : 'termin', ...e, query: e.query || e.title }));
}
async function reviewDrafts(drafts, resumed = false) {
  const out = $('#impOut') || $('#sheetBody');
  out.innerHTML = '<div class="row" style="margin-top:12px"><span class="spinner"></span> Suche Orte…</div>';
  // Für den Absprung zu Google: erkannte Einträge sichern
  window._lookupResume = { type: 'import', data: () => ({ drafts: window._drafts }) };
  if (!resumed) for (const d of drafts) {
    d.query = (d.query || '').replace(/\s*\n\s*/g, ' ').replace(/\s+,/g, ',').trim();
    if (d.query) {
      if (d.kind === 'zug') d.place = (await geocode(d.query))[0];
      else d.place = await geocodeSmart(d.query, `${d.title}\n${d.notes || ''}\n${d.context || ''}`); // erkennt z. B. „KOM27, Mauerstraße 27, 10117 Berlin“
      // kein Raten über den Titel – dann lieber nachfragen (Eingabefeld in der Prüfansicht)
    }
  }
  window._drafts = drafts;
  const o2 = $('#impOut') || $('#sheetBody');
  o2.innerHTML = `${resumed ? '<div class="okbox">↩︎ Zurück aus Google – deine Einträge sind noch da. Adresse kopiert? Tippe unten auf „📋 Adresse einfügen“.</div>' : ''}<label class="f">Erkannt – bitte prüfen</label><div class="list">${drafts.map((d, k) => `<div class="card flat" style="margin:0"><label class="row"><input type="checkbox" checked data-k="${k}" style="width:22px;height:22px"><div class="grow"><b>${KIND[d.kind]?.ico || '📍'} ${esc(d.title)}</b><div class="small muted">${d.place ? esc(d.place.name + (d.place.address ? ', ' + d.place.address : '')) : `<span style="color:var(--warn)">„${esc((d.query || '').split(/[,–|]| in (?=[A-ZÄÖÜ])/)[0])}“ – Adresse unbekannt. Bitte suchen oder eingeben:</span><input class="input" data-pq="${k}" style="margin-top:6px;font-size:16px" placeholder="z. B. Straße + Nr., Ort" autocomplete="off"><div data-ps="${k}"></div>`}</div><div class="small">${d.start ? fmtD(d.start) + ', ' + fmtT(d.start) : 'Zeit offen'}${d.checkIn ? ' · Check-in ' + esc(d.checkIn) : ''}${d.train?.name ? ' · ' + esc(d.train.name) : ''}</div></div></label></div>`).join('')}</div>
    <button class="btn primary block" style="margin-top:12px" onclick="importDrafts()">Übernehmen</button>`;
  // unbekannte Orte direkt hier nachtragen; der Name (z. B. „KOM27“) wird mit der gewählten Adresse verknüpft
  $$('[data-pq]', o2).forEach(inp => {
    const k = +inp.dataset.pq, d = drafts[k], nm = (d.query || '').split(/[,–|]| in (?=[A-ZÄÖÜ])/)[0].trim();
    if (resumed) { inp.value = nm; setTimeout(() => inp.dispatchEvent(new Event('input')), 50); }
    placeAutocomplete(inp, $(`[data-ps="${k}"]`, o2), p => {
      d.place = nm && normKey(nm) !== normKey(p.name) ? { ...p, name: nm, address: p.address || p.name } : p;
      if (nm) rememberPlace(nm, d.place);
      inp.insertAdjacentHTML('afterend', `<div class="okbox">✓ ${esc(d.place.name)} = ${esc(d.place.address || '')}</div>`); inp.remove();
    });
  });
}
function importDrafts() {
  const sel = $$('input[data-k]').filter(c => c.checked).map(c => window._drafts[+c.dataset.k]);
  const noPlace = sel.find(d => !d.place);
  if (noPlace) { toast(`Bitte zuerst den Ort für „${noPlace.title}“ angeben`); $(`[data-pq]`)?.focus(); return; }
  const added = sel.map(d => { const e = { id: uid(), kind: d.kind, title: d.title, place: d.place || { name: d.query || d.title, lat: 52.52, lon: 13.40 }, start: d.start || null, end: d.end || null, arriveBy: d.arriveBy || null, checkIn: d.checkIn || '', notes: d.notes || '', train: d.train || null }; S.events.push(e); return e; });
  save(); closeSheet(); toast(`${sel.length} übernommen ✓`); go('plan');
  // Folgeetappe einer Reise? (z. B. Termin in Berlin, während das Hotel in Berlin schon gebucht ist)
  const firstFollow = added.find(e => e.kind !== 'hotel' && e.start && findAnchor(e));
  if (firstFollow) setTimeout(() => offerFollowUp(firstFollow), 350);
  feed('Neue Einträge', sel.map(d => `• ${d.title}${d.start ? ' – ' + fmtD(d.start) + ' ' + fmtT(d.start) : ''}`).join('\n'), 'ok');
}
function exportICS(id) {
  const e = S.events.find(x => x.id === id);
  const f = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const st = e.start || new Date().toISOString(), en = e.end || new Date(new Date(st).getTime() + 3600e3).toISOString();
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Reisebegleiter//DE', 'BEGIN:VEVENT', `UID:${e.id}@reisebegleiter`, `DTSTAMP:${f(new Date().toISOString())}`, `DTSTART:${f(st)}`, `DTEND:${f(en)}`, `SUMMARY:${e.title}`, `LOCATION:${(e.place?.name || '') + (e.place?.address ? ', ' + e.place.address : '')}`.replace(/,/g, '\\,'), `GEO:${e.place?.lat};${e.place?.lon}`, `DESCRIPTION:${(e.notes || '').replace(/\n/g, '\\n')}`, 'BEGIN:VALARM', 'TRIGGER:-PT60M', 'ACTION:DISPLAY', 'DESCRIPTION:Bald losfahren', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })); a.download = `${e.title.replace(/[^\wäöüß-]+/gi, '_')}.ics`; a.click();
}

/* ───────────── ASSISTENZ (Feed + Chat) ───────────── */
function renderAssist() {
  const el = $('#view-assist');
  const items = S.feed.slice(-80);
  el.innerHTML = `${'Notification' in window && Notification.permission !== 'granted' ? `<div class="card"><b>🔔 Mitteilungen aktivieren?</b><div class="small muted">Damit ich dich auch bei gesperrtem Bildschirm warnen kann. Auf dem iPhone: zuerst über Teilen → „Zum Home-Bildschirm“ installieren.</div><button class="btn primary sm" style="margin-top:8px" onclick="askNotifyPermission()">Erlauben</button></div>` : ''}
    <div id="feedList">${items.length ? items.map(m => `<div class="msg ${m.from === 'me' ? 'me' : ''} ${m.level === 'warn' ? 'warn' : m.level === 'bad' ? 'bad' : m.level === 'ok' ? 'ok' : ''}"><div class="av">${m.from === 'me' ? '🙂' : '✦'}</div><div class="bubble">${m.title ? `<div class="tt">${esc(m.title)}</div>` : ''}<div style="white-space:pre-wrap">${esc(m.body || '')}</div>${m.action === 'replan' && S.active ? '<button class="btn sm primary" style="margin-top:8px" onclick="go(\'jetzt\');replan()">Neu planen</button>' : ''}${m.action === 'adoptAlt' && S.active?.alternative ? '<button class="btn sm primary" style="margin-top:8px" onclick="adoptAlt()">Alternative übernehmen</button>' : ''}${m.action === 'takeExit' && S.active?.ride?.recommendExit === m.exitId ? `<button class="btn sm primary" style="margin-top:8px" onclick="setExit('${m.exitId}')">Ausstieg übernehmen</button>` : ''}${m.action === 'startPlan' && !S.active && S.events.some(e => e.id === m.evId) ? `<button class="btn sm primary" style="margin-top:8px" onclick="startFromPlan('${m.evId}')">Begleitung starten</button>` : ''}${m.action === 'preplan' && S.events.some(e => e.id === m.evId) ? `<button class="btn sm primary" style="margin-top:8px" onclick="openPrePlan('${m.evId}')">Neu planen</button>` : ''}${m.action === 'archive' && S.events.some(e => e.id === m.evId) ? `<button class="btn sm primary" style="margin-top:8px" onclick="askArchive('${m.evId}')">Archivieren</button>` : ''}${m.action === 'rideReceipt' && S.pendingRide ? '<button class="btn sm primary" style="margin-top:8px" onclick="rideReceipt()">📷 Beleg erfassen</button>' : ''}${m.action === 'addReceipt' ? '<button class="btn sm primary" style="margin-top:8px" onclick="openExpense()">Beleg erfassen</button>' : ''}${m.action === 'switchTrain' && S.active ? `<button class="btn sm primary" style="margin-top:8px" onclick="openRideSetup('${S.active.eventId}')">Zug wechseln</button>` : ''}${m.chips ? `<div class="chips" style="margin-top:8px">${m.chips.map(c => `<button class="chip" onclick="feedbackChip('${esc(c)}')">${esc(c)}</button>`).join('')}</div>` : ''}<div class="time">${fmtT(m.t)}</div></div></div>`).join('') : '<div class="empty"><div class="ico">✦</div>Hier erscheinen meine Hinweise zu deiner Reise. Du kannst mich auch etwas fragen.</div>'}</div>
    <div class="chips" style="margin-top:12px">${['Wann komme ich an?', 'Wie komme ich zum Hotel?', 'Gibt es Verspätungen?', 'Nachricht: ich verspäte mich'].map(q => `<button class="chip" onclick="ask('${q}')">${q}</button>`).join('')}</div>
    <form class="composer" onsubmit="event.preventDefault();ask(this.q.value);this.q.value=''"><input name="q" placeholder="Frag mich etwas…" autocomplete="off"><button class="btn primary sm">Senden</button></form>`;
  setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 50);
}
function stateSummary() {
  const A = S.active, ev = activeEvent() || nextEvent();
  if (!A) return `Keine aktive Begleitung. Nächstes Ziel: ${ev ? ev.title + (ev.start ? ' um ' + fmtT(ev.start) : '') : 'keins'}.`;
  const it = A.itinerary;
  return `Ziel: ${ev.title} (${ev.place.address || ev.place.name}). Ankunft voraussichtlich ${fmtT(itinEnd(it))}, geplant war ${fmtT(A.plannedEta)}.\nVerbindung:\n` + it.legs.map(l => isTransit(l) ? `- ${legName(l)} ${fmtT(l.startTime)} ${l.from.name}${l.from.track ? ' Gl.' + l.from.track : ''} → ${fmtT(l.endTime)} ${l.to.name} (Verspätung an: ${delayOf(l.to.arrival, l.to.scheduledArrival)} Min${l.cancelled ? ', AUSFALL' : ''})` : `- ${l.mode} ${fmtDur((new Date(l.endTime) - new Date(l.startTime)) / 1000)}`).join('\n') + (GPS.pos ? `\nGPS: ${GPS.pos.lat.toFixed(4)},${GPS.pos.lon.toFixed(4)}, ${Math.round(speedKmh())} km/h` : '');
}
async function ask(q) {
  q = (q || '').trim(); if (!q) return;
  S.feed.push({ id: uid(), t: new Date().toISOString(), body: q, from: 'me' }); save(); renderAssist();
  const A = S.active, ev = activeEvent() || nextEvent();
  let a = null;
  if (S.settings.claudeKey) {
    try { a = await claude([{ type: 'text', text: `Aktueller Reisestand:\n${stateSummary()}\n\nFrage: ${q}` }], 'Du bist eine knappe, freundliche Reise-Assistenz (Deutsch, du-Form). Antworte in max. 5 Sätzen, konkret mit Uhrzeiten, Gleisen und Optionen. Wenn eine Nachricht entworfen werden soll, gib nur den Nachrichtentext.', 600); } catch (e) { console.warn(e); }
  }
  if (!a) {
    const s = q.toLowerCase();
    if (/wann|ankunft|ankomm/.test(s)) a = A ? `Voraussichtliche Ankunft bei ${ev.title}: ${fmtT(itinEnd(A.itinerary))}${mins(new Date(itinEnd(A.itinerary)) - new Date(A.plannedEta)) > 0 ? ` (+${mins(new Date(itinEnd(A.itinerary)) - new Date(A.plannedEta))} Min ggü. Plan)` : ' – im Plan'}.` : 'Starte die Begleitung im Tab „Jetzt“, dann berechne ich deine Ankunft live.';
    else if (/versp|delay|pünkt/.test(s)) a = A ? A.itinerary.legs.filter(isTransit).map(l => `${legName(l)}: ${delayOf(l.to.arrival, l.to.scheduledArrival) > 0 ? '+' + delayOf(l.to.arrival, l.to.scheduledArrival) + ' Min' : 'pünktlich'}${l.cancelled ? ' (fällt aus!)' : ''}`).join('\n') : 'Keine aktive Reise.';
    else if (/hotel|ziel|weg|letzte|bahnhof/.test(s)) { const lm = window._lm?.lm; a = lm ? `Ab ${lm.from.name}: ${lm.transit[0] ? 'ÖPNV ' + lm.transit[0].legs.filter(isTransit).map(legName).join('+') + ', ' : ''}${lm.walk ? 'zu Fuß ' + fmtDur(lm.walk.duration) + ', ' : ''}Uber/Taxi ca. ${fmtDur(lm.car.duration + 300)} für ~${Math.round(lm.taxi)} €. Details im Tab „Jetzt“.` : 'Öffne „Jetzt“ – dort berechne ich den Weg vom Bahnhof zum Ziel.'; }
    else if (/nachricht|bescheid|verspäte mich/.test(s)) a = A ? `Entwurf:\n„Hallo, kleine Info: Ich komme voraussichtlich erst um ${fmtT(itinEnd(A.itinerary))} bei ${ev.title} an (Zugverspätung). Liebe Grüße“` : 'Keine aktive Reise.';
    else if (/uber|taxi/.test(s)) a = ev ? `Uber mit vorausgefülltem Ziel: im Tab „Jetzt“ → Kachel „Uber/Taxi“.` : 'Kein Ziel gewählt.';
    else a = 'Ich kann dir sagen, wann du ankommst, ob es Verspätungen gibt, wie du zum Ziel kommst oder eine Verspätungsnachricht entwerfen. Für freie Fragen: Claude-Schlüssel unter „Mehr“ hinterlegen.';
  }
  feed('', a, 'info');
  if (/nachricht|bescheid/.test(q.toLowerCase()) && navigator.share) setTimeout(() => { const t = a.match(/„([^“]+)“/)?.[1] || a; if (confirm('Nachricht teilen (WhatsApp, Mail…)?')) navigator.share({ text: t }).catch(() => { }); }, 300);
}

/* ───────────── Feedback-Schleife (lernt lokal) ───────────── */
const FB_CHIPS = ['👍 Alles gut', '🔕 Zu viele Mitteilungen', '⏰ Zu spät gewarnt', '🏃 Mehr Umstiegspuffer', '❌ Falsche Daten', '💡 Ich habe einen Wunsch'];
function feedbackPromptCard() {
  if (!S._askFb) return '';
  return `<div class="card" style="border:2px solid var(--accent)"><div class="spread"><b>Kurze Frage: Was kann ich besser machen?</b><button class="btn ghost sm" onclick="S._askFb=false;save();render()">✕</button></div><div class="chips" style="margin-top:10px">${FB_CHIPS.map(c => `<button class="chip" onclick="feedbackChip('${c}')">${c}</button>`).join('')}</div></div>`;
}
function maybeAskFeedback(reason) {
  S._askFb = true; save();
  feed('Wie war die Begleitung?', reason === 'trip' ? 'Deine Reise ist abgeschlossen. Ein Tipp genügt – ich passe mich an.' : 'Hilf mir, besser zu werden:', 'info', { chips: FB_CHIPS });
}
function feedbackChip(c) {
  const st = S.settings; let note = '';
  if (c.includes('Zu viele')) { st.delayThreshold = Math.min(15, st.delayThreshold + 2); note = `Ich melde Verspätungen jetzt erst ab ${st.delayThreshold} Min.`; }
  if (c.includes('Zu spät')) { st.alightLead = Math.min(20, st.alightLead + 3); note = `Ich kündige Ausstiege jetzt ${st.alightLead} Min vorher an.`; }
  if (c.includes('Umstiegspuffer')) { st.transferMin = Math.min(20, st.transferMin + 3); note = `Ich plane jetzt mit mind. ${st.transferMin} Min Umstiegszeit.`; }
  let text = '';
  if (c.includes('Falsche') || c.includes('Wunsch')) text = prompt(c.includes('Wunsch') ? 'Was wünschst du dir?' : 'Was war falsch?') || '';
  S.feedback.push({ t: new Date().toISOString(), chip: c, text, settings: { ...st, claudeKey: undefined, hereKey: undefined } });
  S._askFb = false; save();
  feed('Danke!', (note || 'Notiert.') + (text ? `\n„${text}“ ist gespeichert – unter „Mehr → Verbesserungen“ kannst du alle Wünsche exportieren und zur Weiterentwicklung weitergeben.` : ''), 'ok');
  render();
}
function exportFeedback() {
  const md = `# Reisebegleiter – Feedback & Wünsche\n\nExport: ${new Date().toLocaleString('de-DE')}\n\n## Einstellungen (gelernt)\n- Verspätungs-Schwelle: ${S.settings.delayThreshold} Min\n- Ausstiegs-Vorwarnung: ${S.settings.alightLead} Min\n- Umstiegspuffer: ${S.settings.transferMin} Min\n\n## Rückmeldungen\n${S.feedback.map(f => `- ${new Date(f.t).toLocaleString('de-DE')}: ${f.chip}${f.text ? ' – ' + f.text : ''}`).join('\n') || '- (noch keine)'}\n`;
  if (navigator.share) navigator.share({ title: 'Reisebegleiter Feedback', text: md }).catch(() => { });
  else navigator.clipboard?.writeText(md).then(() => toast('In Zwischenablage kopiert'));
}

/* ───────────── MEHR (Einstellungen) ───────────── */
function renderMehr() {
  const st = S.settings, el = $('#view-mehr');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  el.innerHTML = `
  ${standalone ? '' : `<div class="card" style="border:2px solid var(--accent2)"><h3>📲 Auf dem iPhone installieren</h3><div class="small">In Safari: <kbd>Teilen</kbd> → <kbd>Zum Home-Bildschirm</kbd>. Erst dann sind Mitteilungen möglich und die App startet ohne Browserleiste.</div></div>`}
  <div class="card"><h3>Assistenz</h3>
    <div class="switch"><div><b>Mitteilungen</b><div class="small muted">${'Notification' in window ? (Notification.permission === 'granted' ? 'erlaubt' : 'noch nicht erlaubt') : 'nach Installation verfügbar'}</div></div>${'Notification' in window && Notification.permission !== 'granted' ? '<button class="btn sm primary" onclick="askNotifyPermission()">Erlauben</button>' : `<input type="checkbox" data-s="notify" ${st.notify ? 'checked' : ''}>`}</div>
    <div class="switch"><div><b>Sprachansagen</b><div class="small muted">Hinweise vorlesen (z. B. mit AirPods)</div></div><input type="checkbox" data-s="voice" ${st.voice ? 'checked' : ''}></div>
    <div class="switch"><div><b>Bildschirm wach halten</b><div class="small muted">während der Begleitung – iOS pausiert Web-Apps im Hintergrund</div></div><input type="checkbox" data-s="wakeLock" ${st.wakeLock ? 'checked' : ''}></div>
    <div class="switch"><div><b>Umstiegspuffer</b><div class="small muted">Mindestzeit beim Umsteigen</div></div><select class="input" style="width:110px" data-n="transferMin">${[2, 5, 8, 10, 15, 20].map(v => `<option ${v === st.transferMin ? 'selected' : ''} value="${v}">${v} Min</option>`).join('')}</select></div>
    <div class="switch"><div><b>Verspätung melden ab</b></div><select class="input" style="width:110px" data-n="delayThreshold">${[1, 3, 5, 10, 15].map(v => `<option ${v === st.delayThreshold ? 'selected' : ''} value="${v}">${v} Min</option>`).join('')}</select></div>
    <div class="switch"><div><b>Ausstieg ankündigen</b></div><select class="input" style="width:110px" data-n="alightLead">${[3, 5, 8, 10, 15, 20].map(v => `<option ${v === st.alightLead ? 'selected' : ''} value="${v}">${v} Min vorher</option>`).join('')}</select></div>
    <div class="switch"><div><b>Aktiv eingreifen ab</b><div class="small muted">Umstieg/früheren Ausstieg nur bei so viel Verspätung, Ausfall oder gerissenem Anschluss empfehlen</div></div><select class="input" style="width:110px" data-n="interveneDelay">${[10, 15, 20, 30, 45].map(v => `<option ${v === st.interveneDelay ? 'selected' : ''} value="${v}">${v} Min</option>`).join('')}</select></div>
    <div class="switch"><div><b>Neue Verbindung muss mind.</b><div class="small muted">… so viel früher ankommen</div></div><select class="input" style="width:110px" data-n="minGain">${[5, 10, 15, 20].map(v => `<option ${v === st.minGain ? 'selected' : ''} value="${v}">${v} Min</option>`).join('')}</select></div>
    <div class="switch"><div><b>Risiko je Umstieg</b><div class="small muted">Weniger Umstiege = weniger kann schiefgehen</div></div><select class="input" style="width:110px" data-n="transferPenalty">${[5, 10, 15, 20].map(v => `<option ${v === st.transferPenalty ? 'selected' : ''} value="${v}">${v} Min</option>`).join('')}</select></div>
    <div class="switch"><div><b>Live-Abgleich alle</b></div><select class="input" style="width:110px" data-n="refreshSec">${[30, 60, 120, 300].map(v => `<option ${v === st.refreshSec ? 'selected' : ''} value="${v}">${v < 60 ? v + ' s' : v / 60 + ' Min'}</option>`).join('')}</select></div>
  </div>
  <div class="card"><h3>Reisekosten & Tracking</h3>
    <div class="switch"><div><b>Reise per GPS protokollieren</b><div class="small muted">zeichnet während der Begleitung deine Strecke auf (nur auf dem Gerät)</div></div><input type="checkbox" data-s="trackJourney" ${st.trackJourney ? 'checked' : ''}></div>
    <div class="switch"><div><b>Kilometersatz eigenes Auto</b><div class="small muted">DE-Standard 0,30 €/km</div></div><input class="input" style="width:110px" data-num="kmRate" inputmode="decimal" value="${String(st.kmRate).replace('.', ',')}"></div>
    <div class="switch"><div><b>Verpflegungspauschale</b><div class="small muted">An-/Abreisetag · 24 h</div></div><div class="row"><input class="input" style="width:70px" data-num="perDiemDay" value="${st.perDiemDay}"><input class="input" style="width:70px" data-num="perDiemFull" value="${st.perDiemFull}"></div></div>
  </div>
  <div class="card"><h3>🗺️ Ausbaustufe 2 (vorgemerkt)</h3><div class="small muted">Diese Funktionen gehen nur mit einer nativen iPhone-App bzw. einem eigenen Server und sind fest eingeplant:</div>
    <ul class="small" style="margin:8px 0 0;padding-left:18px">
      <li><b>Live-Aktivität & Dynamic Island</b>: Assistenz dauerhaft auf Sperrbildschirm und in der Leiste oben</li>
      <li><b>Push bei gesperrtem iPhone</b> über einen Server, der deine Reise weiter überwacht</li>
      <li><b>Hintergrund-GPS</b>: Kilometer & Reiseprotokoll auch bei geschlossener App</li>
      <li>„Teilen an Reisebegleiter“ direkt aus Mail/Fotos, Siri-Kurzbefehle, Wallet-Tickets</li>
    </ul></div>
  <div class="card"><h3>KI & Verkehrslage (optional)</h3>
    <div class="small muted">Schlüssel werden nur auf diesem Gerät gespeichert und direkt an den jeweiligen Dienst gesendet.</div>
    <label class="f">Claude API-Schlüssel – versteht E-Mails, Screenshots & freie Fragen</label><input class="input" type="password" data-t="claudeKey" value="${esc(st.claudeKey)}" placeholder="sk-ant-…">
    <label class="f">Claude-Modell</label><select class="input" data-t="claudeModel">${['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].map(m => `<option ${m === st.claudeModel ? 'selected' : ''}>${m}</option>`).join('')}</select>
    <label class="f">HERE API-Schlüssel – Auto-Fahrzeit mit Stau (kostenloses Kontingent)</label><input class="input" type="password" data-t="hereKey" value="${esc(st.hereKey)}" placeholder="optional">
    <label class="f">Google-Maps-Schlüssel (Places API) – findet auch Orte wie Konferenzzentren, die nicht in den freien Karten stehen</label><input class="input" type="password" data-t="googleKey" value="${esc(st.googleKey || '')}" placeholder="optional">
    <div class="small muted" style="margin-top:6px">Gemerkte Orte: ${Object.keys(S.placeAliases || {}).length} ${Object.keys(S.placeAliases || {}).length ? `<a href="#" onclick="if(confirm('Gemerkte Orte löschen?')){S.placeAliases={};save();renderMehr()}return false">löschen</a>` : ''}</div>
  </div>
  <div class="card"><h3>Verbesserungen</h3><div class="small muted">${S.feedback.length} Rückmeldungen gespeichert. Die App passt Schwellen selbst an; Wünsche kannst du exportieren und zur Weiterentwicklung weitergeben.</div>
    <div class="row wrap" style="margin-top:10px"><button class="btn sm" onclick="maybeAskFeedback('manual');go('assist')">Feedback geben</button><button class="btn sm" onclick="exportFeedback()">Exportieren / Teilen</button></div></div>
  <div class="card"><h3>Daten</h3><div class="row wrap"><button class="btn sm" onclick="backup()">Backup teilen</button><button class="btn sm danger" onclick="if(confirm('Alle Daten löschen?')){localStorage.removeItem(STORE_KEY);location.reload()}">Alles löschen</button></div>
    <div class="small muted" style="margin-top:10px">Fahrplan & Echtzeit: Transitous (MOTIS, offene Daten von DB, VBB u. a.) · Karten: © OpenStreetMap · Adresssuche: Nominatim</div></div>`;
  $$('[data-s]', el).forEach(i => i.onchange = () => { st[i.dataset.s] = i.checked; save(); if (i.dataset.s === 'wakeLock') keepAwake(i.checked && !!S.active); });
  $$('[data-n]', el).forEach(i => i.onchange = () => { st[i.dataset.n] = +i.value; save(); if (i.dataset.n === 'refreshSec') startLoop(); });
  $$('[data-num]', el).forEach(i => i.onchange = () => { const v = parseAmount(i.value); if (v > 0) { st[i.dataset.num] = v; save(); toast('Gespeichert'); } });
  $$('[data-t]', el).forEach(i => i.onchange = () => { st[i.dataset.t] = i.value.trim(); save(); toast('Gespeichert'); });
}
function backup() {
  const d = JSON.stringify({ ...S, settings: { ...S.settings, claudeKey: '', hereKey: '' } }, null, 1);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([d], { type: 'application/json' })); a.download = 'reisebegleiter-backup.json'; a.click();
}

/* ───────────── Sheet-Helfer ───────────── */
/* Fenster (Sheets) mit Verlauf: „‹ Zurück“ stellt den vorherigen Stand wieder her (inkl. Eingaben),
 * „✕“ bricht ab. Die vorherigen Inhalte werden als DOM-Knoten aufgehoben – Eingaben & Knöpfe bleiben funktionsfähig. */
const SH = { stack: [], last: null, closing: null };
function takeSheetNodes() { const b = $('#sheetBody'), f = document.createDocumentFragment(); while (b.firstChild) f.appendChild(b.firstChild); return { f, top: $('#sheet').scrollTop }; }
function openSheet(html) {
  const sheet = $('#sheet'), open = !sheet.classList.contains('hidden');
  if (open && $('#sheetBody').childNodes.length) SH.stack.push(takeSheetNodes());
  else if (SH.closing && SH.last) { clearTimeout(SH.closing); SH.closing = null; SH.stack.push(SH.last); } // closeSheet();openSheet() = Weiter
  SH.last = null;
  if (SH.stack.length > 12) SH.stack.shift();
  $('#sheetBody').innerHTML = html; sheet.classList.remove('hidden'); $('#sheetBackdrop').classList.remove('hidden'); sheet.scrollTop = 0; sheet.style.transform = '';
  $('#sheetBack').classList.toggle('hidden', !SH.stack.length);
}
function closeSheet() {
  const sheet = $('#sheet'); if (sheet.classList.contains('hidden')) return;
  SH.last = takeSheetNodes();
  sheet.classList.add('hidden'); $('#sheetBackdrop').classList.add('hidden'); sheet.style.transform = '';
  clearTimeout(SH.closing); SH.closing = setTimeout(() => { SH.stack = []; SH.last = null; SH.closing = null; }, 400);
}
function backSheet() {
  const prev = SH.stack.pop(); if (!prev) return closeSheet();
  const b = $('#sheetBody'); b.innerHTML = ''; b.appendChild(prev.f); $('#sheet').scrollTop = prev.top || 0;
  $('#sheetBack').classList.toggle('hidden', !SH.stack.length);
}
function segBind(sel, fn) { $$(sel + ' button').forEach(b => b.onclick = () => { if (b.disabled) return; $$(sel + ' button').forEach(x => x.classList.toggle('on', x === b)); fn(b); }); }

/* ───────────── Start ───────────── */
function seed() {
  // Keine persönlichen Daten im (öffentlichen) Code – nur eine Begrüßung
  if (S.events.length || S._seeded) return;
  S._seeded = true; save();
  feed('Hallo! 👋', 'Tippe auf ＋ und trag dein Ziel ein (z. B. dein Hotel) – oder übernimm es aus einer E-Mail, Einladung oder einem Screenshot.\nSitzt du schon im Zug? Dann in „Jetzt“ auf „Ich sitze schon im Zug“ – ich erkenne den Zug per GPS.', 'ok');
}
function init() {
  seed();
  S.opens++; if (S.opens % 7 === 0 && S.feedback.length < 50) S._askFb = true; save();
  $$('.tabbar button[data-view]').forEach(b => b.onclick = () => go(b.dataset.view));
  $('#addBtn').onclick = () => openAdd();
  $('#sheetBackdrop').onclick = closeSheet;
  if (S.settings.theme !== 'auto') document.documentElement.dataset.theme = S.settings.theme;
  if ('serviceWorker' in navigator && location.hostname !== 'localhost') navigator.serviceWorker.register('sw.js').then(r => swReg = r).catch(() => { });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.active) { refreshActive(); keepAwake(S.settings.wakeLock); } });
  const v = location.hash.slice(1); go(TITLES[v] ? v : 'jetzt');
  if (S.active) { startGPS(); startLoop(); refreshActive(true); keepAwake(S.settings.wakeLock); }
  else if (navigator.permissions) navigator.permissions.query({ name: 'geolocation' }).then(p => { if (p.state === 'granted') startGPS(); }).catch(() => { });
  if (S.drive) { startGPS(); keepAwake(true); }
  purgeArchive();
  setTimeout(resumeLookup, 1200); // iOS hat die App beim Wechsel zu Google evtl. beendet → Planung wiederherstellen
  if (S.guideState?.dest) startWalkGuide(S.guideState.dest, S.guideState.ctx || {}); // laufende Führung fortsetzen
  if (S.transitGuide || S.pendingGuide) startGPS();
  $('#settingsBtn').onclick = () => go('mehr');
  $('#liveBar').onclick = () => go('jetzt');
  $('#buddy').onclick = () => { const m = [...S.feed].reverse().find(x => x.from !== 'me'); const b = $('#buddyBubble'); if (b.classList.contains('hidden') && m) showBuddy(m); else go('assist'); };
  $('#buddyBubble').onclick = () => go('assist');
  renderLive();
}
// erst starten, wenn alle Skripte (inkl. costs.js) geladen sind
window.addEventListener('DOMContentLoaded', init);
