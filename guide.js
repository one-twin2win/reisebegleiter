/* Reisebegleiter – Wegführung (zu Fuß / ÖPNV) & Haltestellen-Finder
 * - Fußweg: GPS-Führung mit einfachen Anweisungen (Abbiegen, Straße, Meter) oder Übergabe an Google Maps / Apple Karten
 * - Haltestellen-Finder: richtiger Steig (z. B. „Normaluhr H.3“ von 6 gleichnamigen), Lage, Linien, Orientierungspunkte
 */
'use strict';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const COMPASS = ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten'];
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
function bearing(a, b) {
  const t = x => x * Math.PI / 180, y = Math.sin(t(b.lon - a.lon)) * Math.cos(t(b.lat));
  const x = Math.cos(t(a.lat)) * Math.sin(t(b.lat)) - Math.sin(t(a.lat)) * Math.cos(t(b.lat)) * Math.cos(t(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const compass = deg => COMPASS[Math.round(deg / 45) % 8];
const baseName = n => String(n || '').split(',').pop().replace(/\(.*?\)/g, '').replace(/^(aachen|berlin|s\+u|u|s)\s+/i, '').trim().toLowerCase();

/* ───────────── Kompass (iPhone: Erlaubnis nötig) ───────────── */
let heading = null;
async function enableCompass() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      const p = await DeviceOrientationEvent.requestPermission(); if (p !== 'granted') { toast('Kompass nicht erlaubt'); return; }
    }
    window.addEventListener('deviceorientation', e => {
      heading = e.webkitCompassHeading ?? (e.alpha != null ? (360 - e.alpha) % 360 : null);
      updateArrow();
    }, true);
    toast('Kompass aktiv – der Pfeil zeigt jetzt in Gehrichtung');
  } catch { toast('Kompass nicht verfügbar'); }
}
function updateArrow() {
  const el = $('#gArrow'); if (!el || !GUIDE.aim || !GPS.pos) return;
  // Mit Kompass: echter Richtungspfeil; ohne: Abbiege-Symbol (nicht drehen)
  if (heading == null) { el.style.transform = 'none'; return; }
  if (el.textContent !== '✓') el.textContent = '↑';
  el.style.transform = `rotate(${bearing(GPS.pos, GUIDE.aim) - heading}deg)`;
}

/* ───────────── Haltestellen-Infos ───────────── */
async function overpass(q) {
  // OSM-Server sind öfter überlastet → POST, kurze Timeouts, mehrere Server; Ergebnis 7 Tage lokal merken
  const ck = 'ovp:' + q.length + ':' + q.slice(40, 120);
  try { const c = JSON.parse(localStorage.getItem(ck) || 'null'); if (c && Date.now() - c.t < 7 * 86400e3) return c.v; } catch { }
  for (const ep of OVERPASS) {
    try {
      const v = await getJSON(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 12000);
      try { localStorage.setItem(ck, JSON.stringify({ t: Date.now(), v })); } catch { }
      return v;
    } catch { /* nächster Server */ }
  }
  return null;
}
const stopCache = {};
const withTimeout = (ms, p) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
async function stopInfo(stop, leg) {
  const key = `${stop.stopId || stop.name}`; if (stopCache[key]) return stopCache[key];
  const info = { siblings: [], landmarks: [], street: '', target: null, lines: {} };
  const [ov, st, rev] = await Promise.allSettled([
    withTimeout(9000, overpass(`[out:json][timeout:20];(node(around:400,${stop.lat},${stop.lon})[highway=bus_stop];node(around:400,${stop.lat},${stop.lon})[railway=tram_stop];node(around:400,${stop.lat},${stop.lon})[public_transport=platform];)->.s;.s out;(node(around:60,${stop.lat},${stop.lon})[name][amenity];node(around:60,${stop.lat},${stop.lon})[name][shop];node(around:60,${stop.lat},${stop.lon})[name][tourism];node(around:60,${stop.lat},${stop.lon})[name][historic];);out 20;`)),
    // Fahrplan: alle Steige im Umkreis (auch gleichnamige Haltestellen an anderen Orten, z. B. „Normaluhr“ H.1–H.6)
    stop.stopId && stop.stopId !== 'x' ? getJSON(`${API}/v5/stoptimes?${qs({ stopId: stop.stopId, n: 250, radius: 400, mode: 'BUS,TRAM,SUBWAY,COACH' })}`) : Promise.resolve(null),
    getJSON(`https://nominatim.openstreetmap.org/reverse?${qs({ lat: stop.lat, lon: stop.lon, format: 'json', zoom: 17, 'accept-language': 'de' })}`)
  ]);
  const bn = baseName(stop.name);
  // Linien je Steig aus dem Fahrplan
  if (st.status === 'fulfilled' && st.value) for (const x of st.value.stopTimes || []) {
    const pb = baseName(x.place.name);
    if (!x.place.track || !(pb.includes(bn) || bn.includes(pb))) continue; // nur gleichnamige Haltestellen
    const k = x.place.track + '|' + Math.round(x.place.lat * 2000) + '|' + Math.round(x.place.lon * 2000);
    info.lines[k] ||= { track: x.place.track, lat: x.place.lat, lon: x.place.lon, lines: new Set(), heads: new Set() };
    info.lines[k].lines.add(x.displayName || x.routeShortName); info.lines[k].heads.add(x.headsign);
  }
  if (ov.status === 'fulfilled' && ov.value) {
    for (const e of ov.value.elements || []) {
      const t = e.tags || {}, isStop = t.highway === 'bus_stop' || t.railway === 'tram_stop' || t.public_transport === 'platform';
      if (isStop && t.name && (baseName(t.name).includes(bn) || bn.includes(baseName(t.name))))
        info.siblings.push({ ref: t.local_ref || t.ref || '', lat: e.lat, lon: e.lon, shelter: t.shelter === 'yes', bench: t.bench === 'yes', name: t.name });
      else if (!isStop && t.name) info.landmarks.push({ name: t.name, kind: t.amenity || t.shop || t.tourism || t.historic, d: haversine(stop, { lat: e.lat, lon: e.lon }) });
    }
  }
  // Steige ohne OSM-Treffer aus dem Fahrplan ergänzen
  Object.values(info.lines).forEach(l => { if (l.track && !info.siblings.some(s => normRef(s.ref) === normRef(l.track) && haversine(s, l) < 60)) info.siblings.push({ ref: l.track, lat: l.lat, lon: l.lon }); });
  // doppelte (gleicher Steig) entfernen
  const seen = new Set(); info.siblings = info.siblings.filter(s => { const k = normRef(s.ref) + '|' + Math.round(s.lat * 3000); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => normRef(a.ref).localeCompare(normRef(b.ref), 'de', { numeric: true }));
  const track = normRef(stop.track || '');
  info.target = info.siblings.find(s => track && normRef(s.ref) === track && haversine(s, stop) < 120) || info.siblings.slice().sort((a, b) => haversine(a, stop) - haversine(b, stop))[0];
  if (info.target && haversine(info.target, stop) > 60) info.target = null;
  info.siblings.forEach(s => { const l = Object.values(info.lines).find(l => normRef(l.track) === normRef(s.ref) && haversine(s, l) < 60); if (l) { s.lines = [...l.lines]; s.heads = [...l.heads]; } });
  if (rev.status === 'fulfilled' && rev.value) { const a = rev.value.address || {}; info.street = a.road || a.pedestrian || a.square || ''; info.quarter = a.suburb || a.city_district || ''; }
  info.landmarks.sort((a, b) => a.d - b.d);
  return (stopCache[key] = info);
}
const normRef = r => String(r || '').toUpperCase().replace(/^(H|STEIG|BSTG|GLEIS|GL|POS)\.?\s*/i, '').replace(/\s+/g, '');
const refLabel = r => r ? (/^[A-Z]?\d+[A-Z]?$/i.test(String(r).trim()) ? `Steig ${r}` : r) : '';

/* Einfache Hinweise zum Finden der Haltestelle */
function stopDirections(stop, leg, info, pos) {
  const tgt = info.target || stop, lines = [], ref = info.target?.ref || stop.track;
  const n = info.siblings.length;
  if (pos) {
    const d = haversine(pos, tgt), dir = compass(bearing(pos, tgt));
    if (d < 25) lines.push(`✅ Du stehst an der richtigen Haltestelle${ref ? ' (' + refLabel(ref) + ')' : ''}.`);
    else lines.push(`➡️ ${fmtKm(d)} Richtung ${dir}${d > 60 ? ` (ca. ${Math.max(1, Math.round(d / 75))} Min zu Fuß)` : ''}.`);
    const closest = info.siblings.slice().sort((a, b) => haversine(a, pos) - haversine(b, pos))[0];
    if (closest && info.target && closest !== info.target && haversine(pos, closest) < 40 && d > 25)
      lines.push(`⚠️ Die Haltestelle direkt bei dir ist ${refLabel(closest.ref) || 'eine andere'} – das ist NICHT deine. Deine liegt ${fmtKm(haversine(closest, tgt))} weiter Richtung ${compass(bearing(closest, tgt))}.`);
  }
  if (n > 1) lines.push(`🔎 Es gibt hier ${n} Haltestellen „${esc(stop.name.split(',').pop().trim())}“ an verschiedenen Stellen (${info.siblings.map(s => esc(String(s.ref).replace(/\s*\(.*\)/, ''))).filter(Boolean).join(', ')}). Deine: <b>${esc(refLabel(ref) || 'siehe Karte')}</b> – achte auf das Schild am Mast.`);
  const streetInRef = /\((.+)\)/.exec(ref || '')?.[1]; // z. B. „H.2 (Römerstr.)“
  if (streetInRef) lines.push(`🛣️ Der Steig liegt an der ${esc(streetInRef)}.`);
  else if (info.street) lines.push(`🛣️ Sie liegt an der ${esc(info.street)}.`);
  if (info.landmarks.length) lines.push(`🏛️ Orientierung: ${info.landmarks.slice(0, 2).map(l => `${esc(l.name)} (${Math.round(l.d)} m)`).join(', ')}.`);
  if (info.target && info.target.shelter !== undefined) lines.push(info.target.shelter ? '🚏 Mit Wartehäuschen.' : '🚏 Nur Haltestellenmast, kein Wartehäuschen.');
  if (leg) lines.push(`🚌 Steig ein in <b>${esc(legName(leg))}</b> Richtung <b>${esc(leg.headsign || leg.to.name)}</b> – Abfahrt ${fmtT(leg.startTime)}${delayOf(leg.from.departure, leg.from.scheduledDeparture) > 0 ? ` (+${delayOf(leg.from.departure, leg.from.scheduledDeparture)})` : ''}.`);
  if (info.target?.lines?.length) lines.push(`ℹ️ Hier fahren: ${info.target.lines.slice(0, 8).map(esc).join(', ')}.`);
  return lines;
}

async function openStopFinder(leg) {
  const stop = leg.from;
  openSheet(`<h2>📍 ${esc(stop.name)}${stop.track ? ' · ' + esc(refLabel(stop.track)) : ''}</h2>
    <div class="muted small">${esc(legName(leg))} → ${esc(leg.headsign || leg.to.name)} · ab ${fmtT(leg.startTime)}</div>
    <div id="sfMap" class="map"></div><div id="sfText"><div class="row" style="margin-top:10px"><span class="spinner"></span> Suche Steig & Orientierungspunkte…</div></div>
    <div class="list" style="margin-top:12px">
      <button class="btn primary block" id="sfGo">🚶 Mich per GPS hinführen</button>
      <a class="btn block" target="_blank" rel="noopener" href="${esc(googleWalk(stop))}">In Google Maps öffnen</a>
    </div>`);
  $('#sfGo').onclick = () => { closeSheet(); startWalkGuide({ lat: stop.lat, lon: stop.lon, name: `${stop.name}${stop.track ? ' ' + refLabel(stop.track) : ''}` }, { stop, leg }); };
  let pos = null; try { pos = await getPosOnce(); } catch { /* ohne GPS */ }
  const info = await stopInfo(stop, leg);
  const t = $('#sfText'); if (!t) return;
  t.innerHTML = `<div class="card flat" style="margin-top:10px">${stopDirections(stop, leg, info, pos).map(l => `<div style="margin:4px 0">${l}</div>`).join('')}</div>`;
  drawStopMap('sfMap', stop, info, pos);
}
function drawStopMap(elId, stop, info, pos, route) {
  if (!window.L || !$('#' + elId)) return null;
  const m = L.map(elId, { zoomControl: false, attributionControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(m);
  const pts = [];
  if (route) { L.polyline(route, { color: '#5b4bf5', weight: 5, dashArray: '2 8', lineCap: 'round' }).addTo(m); pts.push(...route); }
  (info?.siblings || []).forEach(s => {
    const isT = info.target === s;
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html: `<div class="stopmark ${isT ? 'tgt' : ''}">${esc(s.ref || '•')}</div>`, iconSize: null }) }).addTo(m);
    if (isT) pts.push([s.lat, s.lon]);
  });
  if (!info?.target && stop) { L.marker([stop.lat, stop.lon], { icon: L.divIcon({ className: '', html: `<div class="stopmark tgt">${esc(stop.track || '◎')}</div>` }) }).addTo(m); pts.push([stop.lat, stop.lon]); }
  if (pos) { L.circleMarker([pos.lat, pos.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#2f7bff', fillOpacity: 1 }).addTo(m); pts.push([pos.lat, pos.lon]); }
  if (pts.length > 1) m.fitBounds(pts, { padding: [36, 36], maxZoom: 18 }); else if (pts.length) m.setView(pts[0], 18);
  return m;
}
const googleWalk = p => `https://www.google.com/maps/dir/?${qs({ api: 1, destination: `${p.lat},${p.lon}`, travelmode: 'walking' })}`;
const appleWalk = p => `https://maps.apple.com/?${qs({ daddr: `${p.lat},${p.lon}`, dirflg: 'w' })}`;

/* ───────────── Fußweg-Führung ───────────── */
const DIRS = { DEPART: 'Los', CONTINUE: 'Geradeaus', LEFT: 'Links abbiegen', SLIGHTLY_LEFT: 'Leicht links halten', HARD_LEFT: 'Scharf links', RIGHT: 'Rechts abbiegen', SLIGHTLY_RIGHT: 'Leicht rechts halten', HARD_RIGHT: 'Scharf rechts', UTURN_LEFT: 'Umdrehen', UTURN_RIGHT: 'Umdrehen', CIRCLE_CLOCKWISE: 'Kreisverkehr', CIRCLE_COUNTERCLOCKWISE: 'Kreisverkehr', ELEVATOR: 'Aufzug nehmen', STAIRS: 'Treppe', ENTER_STATION: 'Station betreten', EXIT_STATION: 'Station verlassen', FOLLOW_SIGNS: 'Beschilderung folgen' };
const DIR_ICON = { LEFT: '↰', SLIGHTLY_LEFT: '↖', HARD_LEFT: '↰', RIGHT: '↱', SLIGHTLY_RIGHT: '↗', HARD_RIGHT: '↱', UTURN_LEFT: '↶', UTURN_RIGHT: '↷', CONTINUE: '↑', DEPART: '↑', CIRCLE_CLOCKWISE: '⟳', CIRCLE_COUNTERCLOCKWISE: '⟲', ELEVATOR: '⇅', STAIRS: '⇅' };
function simplifySteps(steps) {
  const out = [];
  for (const s of steps || []) {
    const p = s.polyline ? decodePolyline(s.polyline.points, s.polyline.precision || 6) : [];
    const st = { dir: s.relativeDirection || 'CONTINUE', street: (s.streetName || '').trim(), dist: s.distance || 0, pt: p[0] ? { lat: p[0][0], lon: p[0][1] } : null };
    const last = out[out.length - 1];
    if (last && (st.dir === 'CONTINUE' && (st.street === last.street || !st.street) || st.dist < 8 && st.dir === 'CONTINUE')) { last.dist += st.dist; if (!last.street) last.street = st.street; continue; }
    out.push(st);
  }
  return out;
}
/* Manöver aus der Weggeometrie ableiten (Abbiegungen ≥ 35°), Treppen/Aufzüge aus den Routing-Schritten übernehmen */
function simplifyLine(pts, tol) {
  if (pts.length < 3) return pts.map((p, i) => ({ p, i }));
  const k = Math.cos(pts[0][0] * Math.PI / 180) * 111320, xy = pts.map(p => [p[1] * k, p[0] * 110540]);
  const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1;
    const [x1, y1] = xy[a], [x2, y2] = xy[b], L = Math.hypot(x2 - x1, y2 - y1) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((x2 - x1) * (y1 - xy[i][1]) - (x1 - xy[i][0]) * (y2 - y1)) / L; if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = true; st.push([a, mi], [mi, b]); }
  }
  return pts.map((p, i) => ({ p, i })).filter(x => keep[x.i]);
}
function buildManeuvers(route, rawSteps) {
  const sp = simplifyLine(route, 10), man = [{ dir: 'DEPART', idx: 0, street: '' }];
  for (let k = 1; k < sp.length - 1; k++) {
    const P = q => ({ lat: q[0], lon: q[1] });
    const t = ((bearing(P(sp[k].p), P(sp[k + 1].p)) - bearing(P(sp[k - 1].p), P(sp[k].p)) + 540) % 360) - 180;
    if (Math.abs(t) < 35) continue;
    const a = Math.abs(t), side = t > 0 ? 'RIGHT' : 'LEFT';
    man.push({ dir: a > 130 ? 'UTURN_' + side : a > 100 ? 'HARD_' + side : a < 55 ? 'SLIGHTLY_' + side : side, idx: sp[k].i, street: '' });
  }
  // Treppen/Aufzüge aus den Routing-Schritten
  for (const s of rawSteps || []) if (['STAIRS', 'ELEVATOR', 'ENTER_STATION', 'EXIT_STATION'].includes(s.relativeDirection) && s.polyline) {
    const p = decodePolyline(s.polyline.points, s.polyline.precision || 6)[0]; if (!p) continue;
    const idx = nearestIdx({ lat: p[0], lon: p[1] }).i; man.push({ dir: s.relativeDirection, idx, street: '' });
  }
  man.sort((a, b) => a.idx - b.idx);
  // zu dicht beieinander liegende Manöver zusammenfassen (Zickzack an Kreuzungen)
  const out = [];
  for (const m of man) { const last = out[out.length - 1]; if (last && GUIDE.cum[m.idx] - GUIDE.cum[last.idx] < 12 && m.dir !== 'STAIRS') continue; out.push(m); }
  out.forEach((m, i) => {
    m._at = GUIDE.cum[m.idx]; m.pt = { lat: route[m.idx][0], lon: route[m.idx][1] };
    m.dist = (i < out.length - 1 ? GUIDE.cum[out[i + 1].idx] : GUIDE.cum[GUIDE.cum.length - 1]) - m._at;
    const nx = route[Math.min(route.length - 1, m.idx + 2)]; m._bearing = bearing(m.pt, { lat: nx[0], lon: nx[1] });
  });
  return out;
}
/* Straßennamen nachladen (Nominatim, max. 1 Anfrage/Sekunde) */
async function nameStreets(steps, token) {
  for (const s of steps) {
    if (GUIDE.token !== token) return;
    const j = Math.min(GUIDE.route.length - 1, GUIDE.cum.findIndex(c => c >= s._at + 20));
    const p = GUIDE.route[j < 0 ? GUIDE.route.length - 1 : j], key = `rg:${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    let name = null; try { name = localStorage.getItem(key); } catch { }
    if (name == null) {
      try {
        const r = await getJSON(`https://nominatim.openstreetmap.org/reverse?${qs({ lat: p[0], lon: p[1], format: 'json', zoom: 17, 'accept-language': 'de' })}`);
        const a = r.address || {}; name = a.road || a.pedestrian || a.footway || a.square || a.path || '';
        try { localStorage.setItem(key, name); } catch { }
      } catch { name = ''; }
      await sleep(1100);
    }
    s.street = name; if (GUIDE.on) guideTick();
  }
}
function stepText(s, i) {
  const street = s.street && !/^(Fußweg|footway|path|$)/i.test(s.street) ? s.street : '';
  if (i === 0) return `Los Richtung ${compass(s._bearing ?? 0)}${street ? ' auf der ' + street : ''} – ${fmtKm(s.dist)}`;
  if (s.dir === 'CONTINUE') return `Geradeaus${street ? ' auf der ' + street : ''} – ${fmtKm(s.dist)}`;
  if (['STAIRS', 'ELEVATOR', 'ENTER_STATION', 'EXIT_STATION'].includes(s.dir)) return `${DIRS[s.dir]}, dann ${fmtKm(s.dist)} weiter`;
  return `${DIRS[s.dir] || 'Weiter'}${street ? (/^(LEFT|RIGHT|HARD|SLIGHT)/.test(s.dir) ? ' in die ' : ' – ') + street : ''}, dann ${fmtKm(s.dist)}`;
}

const GUIDE = { on: false, dest: null, ctx: null, route: [], cum: [], steps: [], map: null, lastPlan: 0, off: 0, aim: null, said: {} };
async function startWalkGuide(dest, ctx = {}) {
  let pos;
  try { pos = await getPosOnce(); } catch { toast('Bitte Standort erlauben'); return; }
  startGPS(); keepAwake(true);
  Object.assign(GUIDE, { on: true, dest, ctx, said: {}, off: 0 });
  S.guideState = { dest, ctx: { stop: ctx.stop || null, leg: ctx.leg || null, next: ctx.next || null }, started: new Date().toISOString() }; save();
  renderGuideShell();
  await planWalk(pos);
}
async function planWalk(pos) {
  GUIDE.lastPlan = Date.now();
  try {
    const r = await planJourney({ lat: pos.lat, lon: pos.lon }, GUIDE.dest, { directModes: 'WALK', num: 1, maxDirectTime: 10800 });
    const w = (r.direct || []).find(d => d.legs[0].mode === 'WALK')?.legs[0];
    if (!w) throw new Error('Kein Fußweg gefunden');
    GUIDE.route = decodePolyline(w.legGeometry.points, w.legGeometry.precision || 6);
    GUIDE.cum = [0]; for (let i = 1; i < GUIDE.route.length; i++) GUIDE.cum[i] = GUIDE.cum[i - 1] + haversine({ lat: GUIDE.route[i - 1][0], lon: GUIDE.route[i - 1][1] }, { lat: GUIDE.route[i][0], lon: GUIDE.route[i][1] });
    GUIDE.steps = buildManeuvers(GUIDE.route, w.steps);
    GUIDE.total = GUIDE.cum[GUIDE.cum.length - 1];
    GUIDE.token = uid(); nameStreets(GUIDE.steps, GUIDE.token);
  } catch (e) { GUIDE.route = [[pos.lat, pos.lon], [GUIDE.dest.lat, GUIDE.dest.lon]]; GUIDE.steps = []; GUIDE.cum = [0, haversine(pos, GUIDE.dest)]; GUIDE.total = GUIDE.cum[1]; toast('Nur Luftlinie verfügbar'); }
  drawGuideMap(); guideTick();
}
function nearestIdx(p) {
  let best = Infinity, bi = 0;
  GUIDE.route.forEach((r, i) => { const d = haversine(p, { lat: r[0], lon: r[1] }); if (d < best) { best = d; bi = i; } });
  return { i: bi, off: best, d: GUIDE.cum[bi] || 0 };
}
function renderGuideShell() {
  let el = $('#guide');
  if (!el) { el = document.createElement('div'); el.id = 'guide'; el.className = 'guide'; document.body.appendChild(el); }
  const c = GUIDE.ctx || {};
  el.innerHTML = `<div class="g-top"><div class="g-arrow"><span id="gArrow">↑</span></div><div class="grow"><div class="g-instr" id="gInstr">Route wird berechnet…</div><div class="g-sub" id="gSub"></div></div></div>
    <div id="gMap" class="g-map"></div>
    <div class="g-panel">
      <div class="spread"><div><div class="eyebrow">Ziel</div><b>${esc(GUIDE.dest.name || 'Ziel')}</b></div><div class="when" id="gRemain"></div></div>
      ${c.stop ? `<div id="gStop" class="small" style="margin-top:8px"></div>` : ''}
      <div id="gSteps" class="g-steps"></div>
      <div class="row wrap" style="margin-top:10px">
        <a class="btn sm" target="_blank" rel="noopener" href="${esc(googleWalk(GUIDE.dest))}">Google Maps</a>
        <a class="btn sm" target="_blank" rel="noopener" href="${esc(appleWalk(GUIDE.dest))}">Apple Karten</a>
        <button class="btn sm" onclick="enableCompass()">🧭 Kompass</button>
        <button class="btn sm danger" onclick="stopGuide()">Beenden</button>
      </div></div>`;
  if (c.stop) stopInfo(c.stop, c.leg).then(info => { GUIDE.stopInfo = info; guideTick(); drawGuideMap(); });
}
function drawGuideMap() {
  if (GUIDE.map) { GUIDE.map.remove(); GUIDE.map = null; }
  GUIDE.map = drawStopMap('gMap', GUIDE.ctx?.stop || { ...GUIDE.dest, track: '🏁' }, GUIDE.stopInfo, GPS.pos, GUIDE.route);
  if (GUIDE.map && GPS.pos) GUIDE.me = L.circleMarker([GPS.pos.lat, GPS.pos.lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#2f7bff', fillOpacity: 1 }).addTo(GUIDE.map);
}
function guideTick() {
  if (!GUIDE.on || !GPS.pos || !$('#guide')) return;
  const pos = GPS.pos, near = GUIDE.route.length ? nearestIdx(pos) : { off: 0, d: 0, i: 0 };
  const toDest = haversine(pos, GUIDE.dest);
  const remain = Math.max(toDest, (GUIDE.total || 0) - near.d);
  if (GUIDE.me) GUIDE.me.setLatLng([pos.lat, pos.lon]);
  // Abweichung → neu berechnen
  if (near.off > 40) GUIDE.off++; else GUIDE.off = 0;
  if (GUIDE.off >= 2 && Date.now() - GUIDE.lastPlan > 25000) { $('#gSub').textContent = 'Du bist vom Weg abgekommen – berechne neu…'; planWalk(pos); return; }
  // nächstes Manöver
  const k = GUIDE.steps.findIndex(s => s._at > near.d + 5);
  const nx = k >= 0 ? GUIDE.steps[k] : null;
  const distToMan = nx ? Math.max(0, nx._at - near.d) : remain;
  GUIDE.aim = nx?.pt || GUIDE.dest;
  const instr = $('#gInstr'), sub = $('#gSub');
  if (toDest < 20) {
    instr.textContent = GUIDE.ctx?.stop ? `Du bist da: ${GUIDE.dest.name}` : `Angekommen: ${GUIDE.dest.name}`;
    sub.textContent = GUIDE.ctx?.leg ? `Warte auf ${legName(GUIDE.ctx.leg)} → ${GUIDE.ctx.leg.headsign || ''} · ${fmtT(GUIDE.ctx.leg.startTime)}` : '';
    $('#gArrow').textContent = '✓';
    if (!GUIDE.said.arr) { GUIDE.said.arr = 1; notify(null, GUIDE.ctx?.stop ? 'Haltestelle erreicht' : 'Ziel erreicht', instr.textContent + (sub.textContent ? ' – ' + sub.textContent : ''), 'ok'); }
  } else {
    instr.textContent = nx ? `In ${fmtKm(distToMan)}: ${stepText(nx, 1).split(', dann')[0]}` : `Noch ${fmtKm(remain)} bis zum Ziel`;
    $('#gArrow').textContent = nx ? (DIR_ICON[nx.dir] || '↑') : '↑';
    sub.textContent = `Richtung ${compass(bearing(pos, GUIDE.aim))}${heading == null ? '' : ''}`;
    if (nx && distToMan < 25 && !GUIDE.said['s' + k]) { GUIDE.said['s' + k] = 1; if (navigator.vibrate) navigator.vibrate([60, 40, 60]); if (S.settings.voice && 'speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(stepText(nx, 1)); u.lang = 'de-DE'; speechSynthesis.speak(u); } }
  }
  $('#gRemain').innerHTML = `${fmtKm(remain)}<div class="small muted">ca. ${Math.max(1, Math.round(remain / 78))} Min</div>`;
  $('#gSteps').innerHTML = GUIDE.steps.map((s, i) => `<div class="g-step ${s._at <= near.d + 5 ? 'done' : ''} ${i === k ? 'cur' : ''}"><span>${DIR_ICON[s.dir] || '↑'}</span><span>${esc(stepText(s, i))}</span></div>`).join('') || '<div class="small muted">Folge der Linie auf der Karte.</div>';
  if (GUIDE.ctx?.stop && GUIDE.stopInfo && $('#gStop')) $('#gStop').innerHTML = stopDirections(GUIDE.ctx.stop, GUIDE.ctx.leg, GUIDE.stopInfo, pos).map(l => `<div style="margin:3px 0">${l}</div>`).join('');
  updateArrow();
}
function stopGuide() {
  GUIDE.on = false; if (GUIDE.map) { GUIDE.map.remove(); GUIDE.map = null; }
  $('#guide')?.remove(); S.guideState = null; save(); if (!S.active && !S.drive) keepAwake(false);
}

/* ───────────── Auswahl der letzten Meile ───────────── */
function chooseWalk(ev, station) {
  openSheet(`<h2>🚶 Zu Fuß zu ${esc(ev.place.name || ev.title)}</h2>
    ${window._lm?.lm?.walk ? `<div class="muted small">${fmtDur(window._lm.lm.walk.duration)} · ${fmtKm(window._lm.lm.walk.legs[0].distance || 0)} ab ${esc(station?.name || '')}</div><div id="walkMap" class="map" style="height:200px"></div>` : ''}
    <div class="muted small" style="margin-top:8px">Wie möchtest du geführt werden?</div>
    <div class="list" style="margin-top:12px">
      <button class="btn primary block" id="wHere">📍 Hier in der App mit GPS (einfache Anweisungen)</button>
      <a class="btn block" target="_blank" rel="noopener" href="${esc(googleWalk(ev.place))}" onclick="setTimeout(closeSheet,300)">Mit Google Maps begleiten</a>
      <a class="btn block" target="_blank" rel="noopener" href="${esc(appleWalk(ev.place))}" onclick="setTimeout(closeSheet,300)">Mit Apple Karten begleiten</a>
    </div>
    <div class="small muted" style="margin-top:10px">Tipp: Die Reise-Begleitung läuft weiter – ich melde mich, wenn du am Ziel bist.</div>`);
  if (window._lm?.lm?.walk) segmentMap('walkMap', window._lm.lm.walk.legs, { dest: ev.place, destLabel: '🏁 ' + (ev.place.name || ev.title) });
  $('#wHere').onclick = async () => {
    closeSheet();
    const pos = await getPosOnce().catch(() => null);
    if (pos && station && haversine(pos, station) > 1500) {
      notify(null, 'Fußweg vorgemerkt', `Ich starte die Führung, sobald du an ${station.name} ankommst.`, 'info', { push: false });
      S.pendingGuide = { dest: { lat: ev.place.lat, lon: ev.place.lon, name: ev.place.name || ev.title }, at: { lat: station.lat, lon: station.lon } }; save(); return;
    }
    startWalkGuide({ lat: ev.place.lat, lon: ev.place.lon, name: ev.place.name || ev.title });
  };
}
function chooseTransit(ev, lm) {
  window._lmIts = lm.transit;
  openSheet(`<h2>🚇 Mit Bus & Bahn zu ${esc(ev.place.name || ev.title)}</h2>
    <div class="muted small">Wähle eine Verbindung. Ich zeige dir die richtige Haltestelle samt Steig, führe dich hin und sage dir, wo du aussteigst.</div>
    <div class="list" style="margin-top:12px">${lm.transit.slice(0, 4).map((it, k) => {
      const f = it.legs.find(isTransit);
      return `<div class="card flat" style="margin:0">${itinSummary(it)}<div class="meta">${f ? `Einstieg: <b>${esc(f.from.name)}${f.from.track ? ' · ' + esc(refLabel(f.from.track)) : ''}</b>` : ''}</div>
      <div class="row" style="margin-top:8px"><button class="btn primary sm" onclick="startTransitGuide(${k})">▶ Begleiten</button><button class="btn sm" onclick="openStopFinder(window._lmIts[${k}].legs.find(isTransit))">📍 Haltestelle zeigen</button></div></div>`;
    }).join('')}</div>
    <a class="btn block" style="margin-top:10px" target="_blank" rel="noopener" href="${esc(googleMaps(ev, 'transit'))}">Stattdessen mit Google Maps</a>`);
}
/* ÖPNV-Begleitung: Fußweg zum Steig → Fahrt → Ausstieg → Fußweg zum Ziel */
function startTransitGuide(k) {
  const it = structuredClone(window._lmIts[k]); closeSheet();
  S.transitGuide = { it, phase: 0, said: {} }; save();
  transitGuideTick(true);
}
function transitGuidePhases(it) {
  const ph = [];
  it.legs.forEach((l, i) => {
    if (isTransit(l)) ph.push({ kind: 'ride', leg: l });
    else if (it.legs[i + 1] && isTransit(it.legs[i + 1])) ph.push({ kind: 'toStop', leg: it.legs[i + 1] });
    else if (i === it.legs.length - 1) ph.push({ kind: 'final', to: l.to });
  });
  if (isTransit(it.legs[0])) ph.unshift({ kind: 'toStop', leg: it.legs[0] });
  return ph;
}
async function transitGuideTick(force) {
  const T = S.transitGuide; if (!T) return;
  const ph = transitGuidePhases(T.it), now = Date.now(), pos = GPS.pos;
  let p = ph[T.phase]; if (!p) { S.transitGuide = null; save(); return; }
  // Phasenwechsel
  if (p.kind === 'toStop' && (pos && haversine(pos, p.leg.from) < 30 || now > new Date(p.leg.startTime).getTime() + 60e3)) { T.phase++; force = true; }
  else if (p.kind === 'ride' && (now > new Date(p.leg.endTime).getTime() || pos && haversine(pos, p.leg.to) < 60 && now > new Date(p.leg.startTime).getTime())) { T.phase++; force = true; }
  p = ph[T.phase]; save();
  if (!p) { notify(null, 'Ziel erreicht', 'Du bist da. Schönen Aufenthalt!', 'ok'); S.transitGuide = null; save(); stopGuide(); return; }
  if (!force) { if (p.kind === 'ride') rideAlert(T, p); return; }
  if (p.kind === 'toStop') {
    try { await refreshLeg(p.leg); } catch { /* ok */ }
    notify(null, `Zur Haltestelle ${p.leg.from.name}${p.leg.from.track ? ' ' + refLabel(p.leg.from.track) : ''}`, `${legName(p.leg)} → ${p.leg.headsign || p.leg.to.name} um ${fmtT(p.leg.startTime)}. Ich führe dich hin.`, 'info');
    startWalkGuide({ lat: p.leg.from.lat, lon: p.leg.from.lon, name: `${p.leg.from.name}${p.leg.from.track ? ' · ' + refLabel(p.leg.from.track) : ''}` }, { stop: p.leg.from, leg: p.leg });
  } else if (p.kind === 'ride') {
    stopGuide();
    const n = (p.leg.intermediateStops || []).length + 1;
    notify(null, `Du fährst mit ${legName(p.leg)}`, `${n} Halt${n > 1 ? 'e' : ''} bis ${p.leg.to.name} (an ${fmtT(p.leg.endTime)}). Ich sage dir rechtzeitig Bescheid.`, 'info', { push: false });
  } else if (p.kind === 'final') {
    const ev = window._lm?.ev; const d = ev ? ev.place : p.to;
    startWalkGuide({ lat: d.lat, lon: d.lon, name: ev?.place?.name || ev?.title || 'Ziel' });
  }
}
function rideAlert(T, p) {
  const left = new Date(p.leg.endTime).getTime() - Date.now();
  const stops = (p.leg.intermediateStops || []).filter(s => new Date(s.arrival || s.departure).getTime() > Date.now()).length;
  if ((left < 2.5 * 60e3 || stops === 0) && !T.said['al' + T.phase]) { T.said['al' + T.phase] = 1; save(); notify(null, `Nächster Halt: ${p.leg.to.name}`, 'Jetzt aussteigen-Knopf drücken / zur Tür gehen.', 'warn'); }
}
function guideOnGPS() {
  if (GUIDE.on) guideTick();
  if (S.transitGuide) transitGuideTick(false);
  if (S.pendingGuide && GPS.pos && haversine(GPS.pos, S.pendingGuide.at) < 400) { const d = S.pendingGuide.dest; S.pendingGuide = null; save(); notify(null, 'Angekommen – Fußweg startet', `Ich führe dich jetzt zu ${d.name}.`, 'ok'); startWalkGuide(d); }
}
setInterval(() => { if (S.transitGuide) transitGuideTick(false); }, 20000);
