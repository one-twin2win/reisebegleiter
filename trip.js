/* Reisebegleiter – Kopfkarte mit Wegpunkten & Zug-Detail
 * Oben steht nur, was für die Weiterreise zählt: aktueller/nächster Zug (antippbar), Umstiege, letzte Meile, Ziel.
 * Zug-Detail: Live-Position auf der Karte, nächste Halte, Ausstiegsgleis, Sitzplatz (Wagen/Platz/Abschnitt).
 */
'use strict';

/* Sitzplatz: aus Buchung/Notizen erkennen oder selbst eintragen */
function seatFor(ev, leg) {
  const saved = (ev.seats || {})[leg.tripShortName || legName(leg)];
  if (saved) return saved;
  if (!LONG.includes(leg.mode)) return null;
  const n = [ev.notes, ev.train?.notes].filter(Boolean).join('\n');
  const train = ev.train?.name ? ev.train.name.replace(/\s+/g, '').toLowerCase() : '';
  if (train && !legName(leg).replace(/\s+/g, '').toLowerCase().includes(train.replace(/^\D+/, ''))) return null;
  const w = n.match(/Wagen\s*(\d{1,3})/i), p = n.match(/Pl(?:atz|ätze)\s*:?\s*([\d ,/+-]+)/i), a = n.match(/Abschnitt\s*:?\s*([A-G](?:\s*[-–]\s*[A-G])?)/i);
  return (w || p) ? { wagen: w?.[1] || '', platz: p?.[1]?.trim() || '', abschnitt: a?.[1] || '' } : null;
}
const seatText = s => s ? [s.wagen && `Wagen ${s.wagen}`, s.platz && `Platz ${s.platz}`, s.abschnitt && `Abschnitt ${s.abschnitt}`].filter(Boolean).join(' · ') : '';

/* Wegpunkte in der Kopfkarte */
/* Letzter „großer“ Zug der Reise: Fernverkehr bevorzugt, sonst Regionalzug, sonst letzter ÖPNV-Abschnitt.
 * Alles danach ist „Weg zum Ziel“ (eine Zeile, Details & Alternativen im Reiter darunter). */
const MAIN_TRAINS = ['HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL'];
function lastMainLeg(it) {
  const r = [...it.legs].reverse();
  return r.find(l => isTransit(l) && MAIN_TRAINS.includes(l.mode)) || r.find(l => isTransit(l) && LONG.includes(l.mode)) || r.find(isTransit);
}
function waypointsHtml(A, ev, now) {
  const legs = A.itinerary.legs, rows = [], main = lastMainLeg(A.itinerary), mi = legs.indexOf(main);
  legs.forEach((l, i) => {
    if (!isTransit(l) || l._void || new Date(l.endTime).getTime() < now || (mi >= 0 && i > mi)) return;
    const riding = new Date(l.startTime).getTime() <= now;
    const dd = delayOf(l.from.departure, l.from.scheduledDeparture), da = delayOf(l.to.arrival, l.to.scheduledArrival);
    const seat = seatFor(ev, l);
    rows.push(`<button class="wp ${riding ? 'now' : ''}" onclick="openTrainDetail(${i})">
      <span class="wp-ico">${modeIcon(l.mode)}</span>
      <span class="grow"><b>${esc(legName(l))}</b> ${riding ? '<span class="wp-tag">du bist hier</span>' : `<span class="wp-sub">ab ${fmtT(l.startTime)}${dd > 0 ? ` <i class="lb-late">+${dd}</i>` : ''}${l.from.track ? ' · Gl. ' + esc(l.from.track) : ''}</span>`}
        <span class="wp-sub" style="display:block">→ an ${fmtT(l.endTime)}${da > 0 ? ` <i class="lb-late">+${da}</i>` : ''} ${esc(shortStop(l.to.name))}${l.to.track ? ', Gl. ' + esc(l.to.track) : ''}${l._buffer != null && l._buffer < 5 ? ` · <i class="lb-late">Umstieg ${l._buffer} Min</i>` : ''}</span>
        ${seat && !riding ? `<span class="wp-sub" style="display:block">💺 ${esc(seatText(seat))}</span>` : ''}</span>
      <span class="wp-chev">›</span></button>`);
  });
  // Weg zum Ziel: geplanter Rest der Verbindung (z. B. „S5 + U2 · 19 Min“); Alternativen (Fuß, Uber …) im Reiter
  const tail = mi >= 0 ? legs.slice(mi + 1) : legs, tt = tail.filter(isTransit);
  const tailDur = tail.length ? (new Date(tail[tail.length - 1].endTime) - new Date(main ? main.endTime : tail[0].startTime)) / 1000 : 0;
  const plan = tt.length ? `${tt.map(legName).join(' + ')} · ${fmtDur(tailDur)}` : tail.length ? `🚶 ${fmtDur(tailDur)} zu Fuß` : '';
  const from = main ? shortStop(main.to.name) : '';
  rows.push(`<button class="wp" onclick="setJetztTab('lm', true)"><span class="wp-ico">🏁</span><span class="grow"><b>Weg zum Ziel${from ? ' ab ' + esc(from) : ''}</b><span class="wp-sub" style="display:block">${plan ? esc(plan) + ' → ' : ''}${esc(ev.place?.name || ev.title)}</span>${A.lmSummary ? `<span class="wp-sub" id="wpLast" style="display:block">Alternative: ${esc(A.lmSummary.text)}</span>` : ''}</span><span class="wp-chev">›</span></button>`);
  const nx = nextStageLine(ev); if (nx) rows.push(nx); // nächste Etappe der Reise (z. B. morgen zum KOM27)
  return `<div class="wps">${rows.join('')}</div>`;
}
const shortStop = n => String(n || '').replace(/^S\+U |^U |^S /, '').replace(/ \(Berlin\)$/, '').replace(/ Hauptbahnhof$/, ' Hbf').replace(/ Bahnhof$/, '');

/* Zug-Detail */
function trainPos(leg) {
  const all = leg._all || [leg.from, ...(leg.intermediateStops || []), leg.to], now = Date.now();
  const t = s => new Date(s.departure || s.arrival || s.scheduledDeparture).getTime(), ta = s => new Date(s.arrival || s.departure || s.scheduledArrival).getTime();
  if (now <= t(all[0])) return { pos: all[0], next: all[0], k: 0, state: 'wartet' };
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i], b = all[i + 1];
    if (now <= ta(b)) {
      if (now <= t(a)) return { pos: a, next: b, k: i, state: `steht in ${shortStop(a.name)}` };
      const f = (now - t(a)) / Math.max(1, ta(b) - t(a));
      return { pos: { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }, next: b, k: i + 1, state: `zwischen ${shortStop(a.name)} und ${shortStop(b.name)}` };
    }
  }
  return { pos: all[all.length - 1], next: null, k: all.length - 1, state: 'am Ziel' };
}
let trainMap = null;
async function openTrainDetail(i) {
  const A = S.active, ev = activeEvent(), leg = A?.itinerary.legs[i]; if (!leg) return;
  try { if (!leg._all) await refreshLeg(leg); } catch { }
  const tp = trainPos(leg), all = leg._all || [leg.from, ...(leg.intermediateStops || []), leg.to];
  const iTo = all.findIndex(s => s.stopId === leg.to.stopId || s.name === leg.to.name);
  const upcoming = all.slice(tp.k, (iTo >= 0 ? iTo : all.length - 1) + 1);
  const seat = seatFor(ev, leg), long = LONG.includes(leg.mode);
  const d = delayOf(leg.to.arrival, leg.to.scheduledArrival);
  openSheet(`<h2>${modeIcon(leg.mode)} ${esc(legName(leg))} <span class="small muted">→ ${esc(leg.headsign || leg.to.name)}</span></h2>
    <div class="row wrap" style="gap:6px">${d > 0 ? `<span class="badge bad">+${d} Min</span>` : leg.realTime ? '<span class="badge on">pünktlich</span>' : ''}${leg.cancelled ? '<span class="badge bad">fällt aus</span>' : ''}<span class="badge">${esc(tp.state)}</span></div>
    <div id="tdMap" class="map"></div>
    ${long ? `<div class="card flat"><div class="spread"><b>💺 Dein Platz</b><button class="btn ghost sm" onclick="editSeat(${i})">${seat ? 'ändern' : 'eintragen'}</button></div>
      <div style="margin-top:4px">${seat ? esc(seatText(seat)) : '<span class="muted small">Wagen & Platz aus deiner Buchung – dann zeige ich sie dir am Gleis.</span>'}</div>
      ${new Date(leg.startTime) > Date.now() ? `<div class="small" style="margin-top:6px">Einstieg: Gleis <b>${esc(leg.from.track || '?')}</b>${seat?.abschnitt ? `, Abschnitt <b>${esc(seat.abschnitt)}</b>` : ''} · ${fmtT(leg.startTime)}</div>` : ''}
      <a class="btn sm" style="margin-top:8px" target="_blank" rel="noopener" href="https://bahn.expert/">Wagenreihung & Gleisabschnitt ansehen ↗</a>
      <div class="small muted" style="margin-top:4px">Für die Wagenreihung gibt es keine offene Datenquelle – der Link öffnet bahn.expert, dort nach „${esc(legName(leg))}“ suchen.</div></div>` : ''}
    <div class="card flat"><b>Nächste Halte</b>${upcoming.map(s => {
      const isExit = s === all[iTo], dl = delayOf(s.arrival, s.scheduledArrival);
      return `<div class="spread small" style="margin-top:6px;${isExit ? 'font-weight:800;color:var(--accent)' : ''}${s.cancelled ? ';text-decoration:line-through;color:var(--bad)' : ''}"><span>${isExit ? '🏁 ' : ''}${esc(shortStop(s.name))}${isExit && s.track ? ' · Gl. ' + esc(s.track) : ''}</span><span>${fmtT(s.arrival || s.departure)}${dl > 0 ? ` <b style="color:var(--bad)">+${dl}</b>` : ''}</span></div>`;
    }).join('')}</div>
    ${A.ride && A.rideOptions?.length > 1 ? `<details class="stops"><summary>Ausstieg ändern</summary><div class="list" style="margin-top:8px">${A.rideOptions.map(o => `<div class="item" onclick="closeSheet();setExit('${o.exit.stopId}')"><div class="grow"><b>${esc(shortStop(o.exit.name))}</b><div class="small muted">an ${fmtT(o.exit.arrival)} · ${o.transfers ?? '?'} Umst. danach</div></div><div class="when">Ziel ${fmtT(o.eta)}</div></div>`).join('')}</div></details>` : ''}`);
  // Karte: Strecke + aktuelle Zugposition + du
  if (!window.L) return;
  if (trainMap) { trainMap.remove(); trainMap = null; }
  trainMap = L.map('tdMap', { zoomControl: false, attributionControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(trainMap);
  const pts = [];
  if (leg.legGeometry) { const g = decodePolyline(leg.legGeometry.points, leg.legGeometry.precision || 6); L.polyline(g, { color: legColor(leg), weight: 5 }).addTo(trainMap); }
  upcoming.forEach(s => { L.circleMarker([s.lat, s.lon], { radius: 4, color: '#666', fillOpacity: 1 }).addTo(trainMap).bindTooltip(shortStop(s.name)); pts.push([s.lat, s.lon]); });
  L.marker([tp.pos.lat, tp.pos.lon], { icon: L.divIcon({ className: '', html: `<div class="stopmark tgt">${modeIcon(leg.mode)} ${esc(legName(leg))}</div>` }) }).addTo(trainMap);
  pts.push([tp.pos.lat, tp.pos.lon]);
  if (GPS.pos && Date.now() - GPS.pos.t < 300000) { L.circleMarker([GPS.pos.lat, GPS.pos.lon], { radius: 7, color: '#fff', weight: 3, fillColor: '#2f7bff', fillOpacity: 1 }).addTo(trainMap); }
  // Fokus auf den Zug und seinen nächsten Halt (die ganze Strecke ist per Zoom sichtbar)
  const focus = [[tp.pos.lat, tp.pos.lon]]; if (tp.next) focus.push([tp.next.lat, tp.next.lon]);
  trainMap.fitBounds(focus, { padding: [40, 40], maxZoom: 11 });
}
/* ───────────── Uber / Taxi: direkt bestellen, danach Beleg ablegen ───────────── */
function chooseRide(ev, lm) {
  const near = GPS.pos && lm?.from && haversine(GPS.pos, lm.from) < 1500; // schon am Bahnhof?
  openSheet(`<h2>🚕 Fahrt zu ${esc(ev.place.name || ev.title)}</h2>
    <div class="muted small">ca. ${fmtDur((lm?.car.duration || 600) + 300)} · Schätzung ${Math.round(lm?.taxi || 0)} € (Berliner Taxitarif; Uber zeigt den echten Preis vor der Buchung)</div>
    <button class="btn primary block" style="margin-top:14px;padding:16px" onclick="orderRide('Uber')">Uber jetzt bestellen<br><span class="small" style="font-weight:500">Abholung: ${near || !lm ? 'dein aktueller Standort' : esc(lm.from.name)} · Ziel ist vorausgefüllt</span></button>
    <div class="row" style="margin-top:8px"><button class="btn grow" onclick="orderRide('Bolt')">Bolt</button><button class="btn grow" onclick="orderRide('FREENOW')">FREENOW</button><button class="btn grow" onclick="orderRide('Taxi')">📞 Taxi</button></div>
    <div class="small muted" style="margin-top:10px">Nach der Fahrt frage ich dich, ob du den Beleg gleich abfotografieren möchtest – er landet automatisch unter Reisekosten.</div>`);
  window._rideCtx = { ev, lm, near };
}
async function orderRide(provider) {
  const { ev, lm, near } = window._rideCtx || {};
  let pos = null; try { pos = near || !lm ? await getPosOnce() : { lat: lm.from.lat, lon: lm.from.lon, name: lm.from.name }; } catch { }
  const links = { Uber: uberLink(ev, pos), Bolt: 'bolt://', FREENOW: 'freenow://', Taxi: 'tel:+4930202020' };
  S.pendingRide = { provider, evId: ev.id, at: Date.now(), dest: ev.place.name || ev.title }; save();
  closeSheet();
  feed(`${provider}-Fahrt`, `Bestellt zu ${ev.place.name || ev.title}. Nach der Fahrt kannst du den Beleg direkt hier ablegen.`, 'info', { action: 'rideReceipt', push: false });
  location.href = links[provider];
}
/* Zurück in der App nach einer Fahrt → Beleg anbieten (frühestens 4 Min nach Bestellung) */
function checkRideReturn() {
  const r = S.pendingRide; if (!r || document.hidden) return;
  const age = Date.now() - r.at;
  if (age > 6 * 3600e3) { S.pendingRide = null; save(); return; }
  const ev = S.events.find(e => e.id === r.evId);
  const arrived = ev && GPS.pos && haversine(GPS.pos, ev.place) < 300;
  if (age < 4 * 60e3 && !arrived) return;
  if ($('#sheet') && !$('#sheet').classList.contains('hidden')) return;
  openSheet(`<h2>🧾 ${esc(r.provider)}-Beleg ablegen?</h2>
    <div class="muted small">Fahrt zu ${esc(r.dest)}. Fotografiere die Quittung oder nimm einen Screenshot der Rechnung in der ${esc(r.provider)}-App – Betrag & Datum lese ich aus.</div>
    <div class="list" style="margin-top:12px">
      <button class="btn primary block" onclick="rideReceipt()">📷 Beleg jetzt erfassen</button>
      <button class="btn block" onclick="S.pendingRide.at=Date.now()+20*60e3-4*60e3;save();closeSheet()">Fahrt läuft noch – später fragen</button>
      <button class="btn ghost block" onclick="S.pendingRide=null;save();closeSheet()">Kein Beleg nötig</button></div>
    <div class="small muted" style="margin-top:8px">Tipp: Die Rechnung von ${esc(r.provider)} kommt meist auch per E-Mail – die PDF kannst du später unter Kosten → Beleg hochladen.</div>`);
}
function rideReceipt() {
  const r = S.pendingRide || {}; S.pendingRide = null; save(); closeSheet();
  openExpense(null, { category: 'taxi', vendor: r.provider || 'Uber', note: r.dest ? `Fahrt zu ${r.dest}` : '', eventId: r.evId || S.active?.eventId || '' });
  $('#expCam')?.click(); // Kamera direkt öffnen (iOS erlaubt das nur direkt nach dem Antippen)
}
document.addEventListener('visibilitychange', () => setTimeout(checkRideReturn, 800));
setInterval(checkRideReturn, 60000);

function editSeat(i) {
  const ev = activeEvent(), leg = S.active.itinerary.legs[i], key = leg.tripShortName || legName(leg);
  const s = seatFor(ev, leg) || {};
  openSheet(`<h2>💺 Platz für ${esc(legName(leg))}</h2>
    <div class="row"><div class="grow"><label class="f">Wagen</label><input class="input" id="seW" inputmode="numeric" value="${esc(s.wagen || '')}"></div>
    <div class="grow"><label class="f">Platz</label><input class="input" id="seP" value="${esc(s.platz || '')}"></div>
    <div class="grow"><label class="f">Abschnitt</label><input class="input" id="seA" placeholder="z. B. C" value="${esc(s.abschnitt || '')}"></div></div>
    <div class="small muted" style="margin-top:6px">Den Abschnitt zeigt die Wagenstandsanzeige am Gleis oder bahn.expert.</div>
    <button class="btn primary block" style="margin-top:12px" id="seS">Speichern</button>`);
  $('#seS').onclick = () => { ev.seats = { ...(ev.seats || {}), [key]: { wagen: $('#seW').value.trim(), platz: $('#seP').value.trim(), abschnitt: $('#seA').value.trim().toUpperCase() } }; save(); closeSheet(); renderJetzt(); toast('Platz gespeichert'); };
}
