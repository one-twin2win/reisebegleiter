/* Reisebegleiter – „In welchem Zug sitzt du?“
 * 1) Automatisch per GPS: alle Züge, die gerade in deiner Umgebung fahren (Echtzeit), werden auf ihre aktuelle
 *    Position gerechnet und mit deinem Standort, deiner Fahrtrichtung und deinem Tempo verglichen.
 * 2) Oder Einstieg + Ziel: Züge, die beide Halte (in dieser Reihenfolge) bedienen und gerade unterwegs sind.
 * Erst nur die 3 wahrscheinlichsten, auf Wunsch mehr – und als letzte Option alle Abfahrten eines Bahnhofs.
 */
'use strict';

const RIDE_MODES = new Set(['HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL', 'REGIONAL_FAST_RAIL', 'REGIONAL_RAIL', 'RAIL', 'SUBURBAN', 'COACH']);
let RF = { cands: [], shown: 3, ev: null, source: '' };

/* Polyline mit unbekannter Genauigkeit (5/6/7) dekodieren – passend zum Starthalt */
function decodeAuto(str, ref) {
  for (const p of [5, 6, 7]) { const pts = decodePolyline(str, p); if (pts.length && (!ref || haversine({ lat: pts[0][0], lon: pts[0][1] }, ref) < 3000)) return pts; }
  return decodePolyline(str, 6);
}
/* Position entlang einer Linie bei Anteil f (0..1) */
function alongLine(pts, f) {
  if (pts.length < 2) return { lat: pts[0][0], lon: pts[0][1], brg: 0 };
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + haversine({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] });
  const target = cum[cum.length - 1] * Math.min(1, Math.max(0, f));
  let i = cum.findIndex(c => c >= target); if (i < 1) i = 1;
  const a = pts[i - 1], b = pts[i], seg = (cum[i] - cum[i - 1]) || 1, g = (target - cum[i - 1]) / seg;
  return { lat: a[0] + (b[0] - a[0]) * g, lon: a[1] + (b[1] - a[1]) * g, brg: bearing({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }), len: cum[cum.length - 1] };
}
/* Deine Bewegung aus dem GPS-Verlauf: Richtung + Tempo */
function myMotion() {
  const h = GPS.history; if (h.length < 2) return { speed: GPS.pos?.speed != null ? GPS.pos.speed * 3.6 : null, brg: null };
  const b = h[h.length - 1]; let a = null;
  for (let i = h.length - 2; i >= 0; i--) if (haversine(h[i], b) > 250) { a = h[i]; break; }
  return { speed: speedKmh(), brg: a ? bearing(a, b) : null };
}
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/* 1) Erkennung per GPS */
async function detectByGPS(pos) {
  const now = Date.now(), dLat = 0.16, dLon = 0.24; // ~18 km Umkreis
  const segs = await getJSON(`${API}/v5/map/trips?${qs({ zoom: 12, min: `${pos.lat - dLat},${pos.lon - dLon}`, max: `${pos.lat + dLat},${pos.lon + dLon}`, startTime: new Date(now - 60e3).toISOString(), endTime: new Date(now + 60e3).toISOString() })}`, {}, 25000);
  const me = myMotion(), best = new Map();
  for (const s of segs) {
    if (!RIDE_MODES.has(s.mode)) continue;
    const dep = new Date(s.departure).getTime(), arr = new Date(s.arrival).getTime();
    let p, moving = true;
    if (now < dep) { p = { lat: s.from.lat, lon: s.from.lon, brg: null }; moving = false; }        // steht noch am Bahnhof
    else if (now > arr) { p = { lat: s.to.lat, lon: s.to.lon, brg: null }; moving = false; }      // gerade angekommen
    else p = alongLine(decodeAuto(s.polyline, s.from), (now - dep) / Math.max(1, arr - dep));
    const dist = haversine(pos, p);
    if (dist > 15000) continue;
    const segKmh = (haversine(s.from, s.to) * 1.15 / 1000) / Math.max(0.01, (arr - dep) / 3600e3);
    let score = dist / 1000, why = [];
    if (me.brg != null && p.brg != null && moving) { const d = angDiff(me.brg, p.brg); if (d > 100) { score += 12; why.push('Gegenrichtung'); } else if (d < 35) { score -= 1; why.push('gleiche Richtung'); } }
    if (me.speed != null) {
      if (me.speed > 25 && !moving) score += 4;                                    // du fährst, Zug steht
      if (me.speed < 5 && moving && segKmh > 40) score += 4;                       // du stehst, Zug fährt
      if (me.speed > 25 && moving && Math.abs(me.speed - segKmh) / segKmh > 0.7) score += 2;
      if (me.speed > 25 && moving && Math.abs(me.speed - segKmh) / segKmh < 0.35) why.push(`Tempo passt (~${Math.round(segKmh)} km/h)`);
    }
    for (const t of s.trips || []) {
      const c = { tripId: t.tripId, name: t.displayName || t.routeShortName, mode: s.mode, headsign: t.headsign || s.to.name, from: s.from, to: s.to, dist, score, why, moving, delay: delayOf(s.arrival, s.scheduledArrival), realTime: s.realTime, segKmh };
      const o = best.get(t.tripId); if (!o || o.score > c.score) best.set(t.tripId, c);
    }
  }
  return [...best.values()].sort((a, b) => a.score - b.score);
}

/* 2) Einstieg + Ziel */
async function detectByStations(board, dest, pos) {
  const now = Date.now();
  const [rf, rn] = await Promise.all([
    stopTimes(board.stopId, new Date(now - 6 * 3600e3), 150, 'HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,COACH'),
    stopTimes(board.stopId, new Date(now - 2 * 3600e3), 150, 'REGIONAL_FAST_RAIL,REGIONAL_RAIL,SUBURBAN')
  ]);
  const seen = new Set(), tDep = x => new Date(x.place.departure || x.place.arrival).getTime();
  const pick = (arr, back, n) => (arr || []).filter(x => !seen.has(x.tripId) && tDep(x) > now - back && tDep(x) < now + 45 * 60e3)
    .sort((a, b) => Math.abs(tDep(a) - now) - Math.abs(tDep(b) - now)).slice(0, n).filter(x => seen.add(x.tripId));
  // Fernverkehr: auch vor Stunden abgefahrene (man sitzt evtl. lange drin); Nahverkehr: kürzeres Fenster
  const past = arr => (arr || []).filter(x => tDep(x) <= now), future = arr => (arr || []).filter(x => tDep(x) > now);
  const deps = [...pick(past(rf.stopTimes), 6 * 3600e3, 40), ...pick(future(rf.stopTimes), 0, 5), ...pick(past(rn.stopTimes), 2 * 3600e3, 12), ...pick(future(rn.stopTimes), 0, 3)];
  const out = [];
  await Promise.all(deps.map(async x => {
    try {
      const tl = (await getTrip(x.tripId)).legs[0], all = [tl.from, ...(tl.intermediateStops || []), tl.to];
      const bi = all.findIndex(s => haversine(s, board) < 700);
      const di = all.findIndex((s, i) => i > bi && haversine(s, dest) < 1500); // nur über die Lage – Namen wie „Hauptbahnhof“ sind mehrdeutig
      if (bi < 0 || di < 0) return;
      const depT = new Date(all[bi].departure || all[bi].scheduledDeparture).getTime(), arrT = new Date(all[di].arrival || all[di].scheduledArrival).getTime();
      if (arrT < now - 10 * 60e3) return; // schon angekommen
      const running = depT <= now && arrT >= now;
      let score = running ? 0 : Math.abs(depT - now) / 60e3 / 10 + 3, dist = null, why = [];
      if (pos && running) { // Position anhand der Echtzeit-Halte schätzen
        const k = all.findIndex(s => new Date(s.arrival || s.departure).getTime() > now);
        if (k > 0) { const a = all[k - 1], b = all[k], ta = new Date(a.departure || a.arrival).getTime(), tb = new Date(b.arrival || b.departure).getTime(), f = Math.min(1, Math.max(0, (now - ta) / Math.max(1, tb - ta)));
          dist = haversine(pos, { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }); score += dist / 1000 / 3; if (dist < 8000) why.push('Position passt'); }
      }
      out.push({ tripId: x.tripId, name: x.displayName || x.routeShortName, mode: x.mode, headsign: x.headsign, from: all[bi], to: all[di], boardIdx: bi, destStop: all[di], dist, score, why, running, delay: delayOf(all[di].arrival, all[di].scheduledArrival), depT, arrT });
    } catch { /* Fahrt nicht abrufbar */ }
  }));
  return out.sort((a, b) => a.score - b.score);
}

/* ───────────── Dialog ───────────── */
function openRideSetup(id) {
  const ev = S.events.find(e => e.id === id) || activeEvent(); if (!ev) return;
  RF = { cands: [], shown: 3, ev, source: '' };
  openSheet(`<h2>In welchem Zug sitzt du?</h2>
    <div class="card flat" style="margin-top:8px"><div class="spread"><b>📍 Automatisch erkennen</b><button class="btn sm" id="rfGps">Per GPS</button></div>
      <div class="small muted">Ich vergleiche deinen Standort, deine Richtung und dein Tempo mit allen Zügen, die gerade in deiner Nähe fahren.</div></div>
    <div class="eyebrow" style="margin:14px 0 6px">oder Einstieg und Ziel angeben</div>
    <div class="row"><div class="grow"><input class="input" id="rfB" placeholder="Eingestiegen in…" autocomplete="off"><div id="rfBS"></div></div></div>
    <div style="margin-top:8px"><input class="input" id="rfD" placeholder="Fahrkarte bis…" value="${esc(ev.train?.to || '')}" autocomplete="off"><div id="rfDS"></div></div>
    <button class="btn primary block" style="margin-top:10px" id="rfGo">Züge vorschlagen</button>
    <div id="rfOut"></div>`);
  let board = null, dest = null;
  placeAutocomplete($('#rfB'), $('#rfBS'), p => board = p, false, true);
  placeAutocomplete($('#rfD'), $('#rfDS'), p => dest = p, false, true);
  $('#rfGps').onclick = () => runGpsDetect();
  $('#rfGo').onclick = async () => {
    const out = $('#rfOut');
    if (!board && $('#rfB').value.trim()) board = (await geocode($('#rfB').value.trim())).find(x => x.type === 'STOP');
    if (!dest && $('#rfD').value.trim()) dest = (await geocode($('#rfD').value.trim())).find(x => x.type === 'STOP');
    if (!board || !dest) { out.innerHTML = '<div class="warnbox">Bitte Einstieg und Ziel wählen.</div>'; return; }
    out.innerHTML = '<div class="row" style="margin-top:12px"><span class="spinner"></span> Prüfe Züge zwischen beiden Halten…</div>';
    try {
      RF.cands = await detectByStations(board, dest, GPS.pos && Date.now() - GPS.pos.t < 120000 ? GPS.pos : null);
      RF.source = 'stations'; RF.dest = dest; RF.shown = 3; renderCands();
    } catch (e) { out.innerHTML = `<div class="badbox">${esc(e.message)}</div>`; }
  };
  // Wenn GPS schon freigegeben ist: sofort automatisch versuchen
  if (GPS.pos && Date.now() - GPS.pos.t < 120000) runGpsDetect();
  else if (navigator.permissions) navigator.permissions.query({ name: 'geolocation' }).then(p => { if (p.state === 'granted') runGpsDetect(); }).catch(() => { });
}
async function runGpsDetect() {
  const out = $('#rfOut'); if (!out) return;
  out.innerHTML = '<div class="row" style="margin-top:12px"><span class="spinner"></span> Suche Züge in deiner Nähe…</div>';
  try {
    const pos = await getPosOnce(); startGPS();
    // Einstiegsfeld mit dem nächsten Bahnhof vorbelegen (hilft bei manueller Eingabe)
    if (!$('#rfB').value) nearestStops(pos.lat, pos.lon).then(st => { const s = st.find(x => /bahnhof|hbf|bf\b/i.test(x.name)) || st[0]; if (s && $('#rfB') && !$('#rfB').value) $('#rfB').placeholder = `Eingestiegen in… (z. B. ${s.name})`; });
    RF.cands = await detectByGPS(pos); RF.source = 'gps'; RF.shown = 3; renderCands();
  } catch (e) { out.innerHTML = `<div class="warnbox">GPS-Erkennung nicht möglich (${esc(e.message || 'kein Standort')}). Gib Einstieg und Ziel an.</div>`; }
}
function confidence(c) {
  if (RF.source === 'gps') return c.dist < 2500 ? ['sehr wahrscheinlich', 'ok'] : c.dist < 7000 ? ['wahrscheinlich', 'warn'] : ['möglich', 'muted'];
  if (c.running && c.dist != null && c.dist < 8000) return ['sehr wahrscheinlich', 'ok'];
  return c.running ? ['fährt gerade', 'warn'] : ['möglich', 'muted'];
}
function renderCands() {
  const out = $('#rfOut'); if (!out) return;
  const list = RF.cands.slice(0, RF.shown);
  if (!list.length) {
    out.innerHTML = `<div class="warnbox" style="margin-top:10px">${RF.source === 'gps' ? 'Kein fahrender Zug in deiner Nähe gefunden.' : 'Kein passender Zug zwischen diesen Halten gefunden.'}</div>
      <button class="btn block" style="margin-top:8px" onclick="closeSheet();openRideSetupAll('${RF.ev.id}')">Alle Züge an einem Bahnhof anzeigen</button>`;
    return;
  }
  const ambiguous = RF.source === 'stations' && RF.cands.filter(c => c.running).length > 1 && !RF.cands.some(c => c.dist != null);
  out.innerHTML = `<label class="f">${RF.shown <= 3 ? 'Wahrscheinlich sitzt du in:' : 'Weitere Möglichkeiten:'}</label>
    ${ambiguous ? `<div class="small muted" style="margin-bottom:8px">Mehrere Züge fahren gerade diese Strecke. <a href="#" onclick="runGpsDetect();return false">Mit GPS genau bestimmen</a> – oder wähle anhand der Abfahrtszeit.</div>` : ''}
    <div class="list">${list.map((c, k) => {
    const [conf, cls] = confidence(c);
    return `<div class="item" onclick="pickCand(${k})"><div class="ic">${modeIcon(c.mode)}</div><div class="grow"><b>${esc(c.name)}</b> <span class="small muted">→ ${esc(c.headsign || c.to.name)}</span>
      <div class="small"><span class="badge ${cls === 'ok' ? 'on' : cls}">${conf}</span> ${RF.source === 'gps' ? `${fmtKm(c.dist)} entfernt` : `ab ${esc(c.from.name)} ${fmtT(c.from.departure)}`}${c.delay > 0 ? ` · <b style="color:var(--bad)">+${c.delay}</b>` : ''}</div>
      ${c.why.length ? `<div class="small muted">${esc(c.why.join(' · '))}</div>` : ''}</div><div class="when small">${RF.source === 'gps' ? `${esc(c.from.name.replace(/ (Bahnhof|Hbf|Hauptbahnhof)$/, ''))} → ${esc(c.to.name.replace(/ (Bahnhof|Hbf|Hauptbahnhof)$/, ''))}` : `an ${fmtT(c.to.arrival)}`}</div></div>`;
  }).join('')}</div>
    ${RF.cands.length > RF.shown ? `<button class="btn ghost block" onclick="RF.shown+=5;renderCands()">Weitere Optionen (${RF.cands.length - RF.shown})</button>` : ''}
    <button class="btn ghost block" onclick="closeSheet();openRideSetupAll('${RF.ev.id}')">Nicht dabei? Alle Züge an einem Bahnhof / Zugnummer</button>`;
}
async function pickCand(k) {
  const c = RF.cands[k], ev = RF.ev; closeSheet(); toast(`${c.name} – berechne Weiterreise…`);
  const ride = { tripId: c.tripId, boardStopId: c.from.stopId, boardLat: c.from.lat, boardLon: c.from.lon, boardName: c.from.name, exitStopId: null, ticketTo: RF.dest?.name || ev.train?.to || '' };
  if (RF.source === 'stations' && c.destStop?.stopId) ride.planExitId = c.destStop.stopId; // Fahrkarte bis …
  try {
    const res = await buildRideItinerary(ride, ev);
    if (!res.best) { toast('Keine Weiterreise gefunden'); return; }
    const chosen = res.options.find(o => o.exit.stopId === ride.planExitId) || res.best; // Fahrkarte bis … ist der Plan
    ride.planExitId = chosen.exit.stopId;
    if (S.active && S.active.eventId === ev.id) {
      Object.assign(S.active, { ride, itinerary: chosen.itinerary, notified: {}, plannedEta: chosen.itinerary.endTime, lastEta: chosen.itinerary.endTime }); save();
      notify(null, 'Zug erkannt', `${c.name} → ${c.headsign || c.to.name}. Ausstieg ${chosen.exit.name}, Ankunft am Ziel voraussichtlich ${fmtT(chosen.itinerary.endTime)}.`, 'ok');
      refreshActive(true);
    } else startCompanion(ev, chosen.itinerary, ride);
  } catch (e) { toast('Fehler: ' + e.message); }
}
