/* Reisebegleiter – Startbild „Jetzt“ (ohne laufende Reise)
 * Titel + wichtigste Daten (kopier-/teilbar), Löschen · Ausblenden · Umplanen,
 * „Ich bin schon unterwegs“ (Zug, Auto, Bus/Bahn, zu Fuß) und eine Optik passend zu Feiertagen.
 */
'use strict';

/* ───────────── Feiertage & Anlässe ───────────── */
function easterSunday(y) { // Gaußsche Osterformel (gregorianisch)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
const DEFAULT_SEASON = { key: '', emoji: '', greet: '', cls: '', ride: { ico: '🧭', text: 'Ich bin schon unterwegs' } };
function season(date = window._seasonDate || new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate()), y = d.getFullYear(), md = (m, day) => new Date(y, m - 1, day);
  const between = (a, b) => d >= a && d <= b, east = easterSunday(y), add = (x, n) => new Date(x.getFullYear(), x.getMonth(), x.getDate() + n);
  if (between(md(12, 27), md(12, 31)) || between(md(1, 1), md(1, 1)))
    return { key: 'nye', emoji: '🎆', greet: d.getMonth() === 0 ? 'Frohes neues Jahr!' : 'Guten Rutsch!', cls: 'season-nye', ride: { ico: '🚀', text: 'Ich sitze schon in der Rakete' } };
  if (between(md(12, 1), md(12, 26)))
    return { key: 'xmas', emoji: '🎄', greet: d.getDate() >= 24 ? 'Frohe Weihnachten!' : d.getDate() === 6 ? 'Schönen Nikolaustag!' : 'Schöne Adventszeit', cls: 'season-xmas', ride: { ico: '🛷', text: 'Ich sitze schon im Schlitten' } };
  if (between(add(east, -52), add(east, -47)))
    return { key: 'carnival', emoji: '🎭', greet: 'Helau & Alaaf!', cls: 'season-carnival', ride: { ico: '🎉', text: 'Ich bin schon im Rosenmontagszug' } };
  if (between(add(east, -3), add(east, 1)))
    return { key: 'easter', emoji: '🐣', greet: 'Frohe Ostern!', cls: 'season-easter', ride: { ico: '🐇', text: 'Ich hoppel schon los' } };
  if (between(md(2, 13), md(2, 14)))
    return { key: 'valentine', emoji: '💘', greet: 'Schönen Valentinstag!', cls: 'season-valentine', ride: { ico: '💘', text: 'Ich schwebe schon auf Wolke 7' } };
  if (between(md(10, 29), md(10, 31)))
    return { key: 'halloween', emoji: '🎃', greet: 'Happy Halloween!', cls: 'season-halloween', ride: { ico: '🧹', text: 'Ich sitze schon auf dem Besen' } };
  return DEFAULT_SEASON;
}

/* ───────────── Startkarte ───────────── */
function eventFacts(ev) {
  const f = [];
  const by = ev.arriveBy || ev.start;
  f.push(['📅', ev.start ? `${fmtD(ev.start)}, ${fmtT(ev.start)}${ev.end ? ' – ' + fmtT(ev.end) : ''}${ev.arriveBy ? ` · spätestens ${dayKey(ev.arriveBy) !== dayKey(ev.start) ? fmtD(ev.arriveBy) + ', ' : ''}${fmtT(ev.arriveBy)} dort` : ''}` : 'Zeit offen']);
  f.push(['📍', [ev.place?.name !== ev.title ? ev.place?.name : '', ev.place?.address].filter(Boolean).join(', ') || ev.place?.name || '']);
  if (ev.kind === 'hotel' && ev.checkIn) f.push(['🔑', `Check-in ab ${ev.checkIn}${ev.end ? ` · Check-out ${fmtD(ev.end)}, ${fmtT(ev.end)}` : ''}`]);
  if (ev.plan) f.push(['🧭', prePlanLine(ev).replace(/^🧭 /, '')]);
  if (ev.booking?.status) f.push(['🏨', ev.booking.status === 'gebucht' ? `Gebucht${ev.booking.nr ? ' · Nr. ' + ev.booking.nr : ''}` : 'Noch nicht gebucht']);
  (ev.notes || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 2).forEach(n => f.push(['📝', n]));
  void by; return f.filter(x => x[1]);
}
function homeCard(ev) {
  const s = season(), facts = eventFacts(ev);
  const more = S.events.filter(e => !e.done && !e.hidden && e.id !== ev.id && (!e.start || new Date(e.start) > Date.now() - 3 * 3600e3)).length;
  return `<div class="hero ${s.cls}">
    <div class="spread"><div class="eyebrow">${s.emoji ? s.emoji + ' ' : ''}Nächstes Ziel${s.greet ? ' · ' + esc(s.greet) : ''}</div>
      <div class="row" style="gap:6px"><button class="btn sm" onclick="copyEvent('${ev.id}')" aria-label="Kopieren">📋</button><button class="btn sm" onclick="shareEvent('${ev.id}')" aria-label="Teilen">↗︎</button></div></div>
    <div class="dest">${KIND[ev.kind]?.ico || '📍'} ${esc(ev.title)}</div>
    <div class="facts">${facts.map(([i, t]) => `<div class="fact"><span>${i}</span><span class="grow">${esc(t)}</span></div>`).join('')}</div>
    ${ev.plan ? '' : `<button class="btn sm" style="margin-top:8px" onclick="openPrePlan('${ev.id}')">🧭 Anreise vorab planen</button>`}
    <div class="row" style="margin-top:14px;gap:8px;flex-wrap:wrap">
      <button class="btn primary" style="flex:1 1 45%" onclick="openStart('${ev.id}')">▶︎ Begleitung starten</button>
      <button class="btn" style="flex:1 1 45%" onclick="openOnTheWay('${ev.id}')">${s.ride.ico} ${esc(s.ride.text)}</button>
    </div>
    <div class="home-actions">
      <button onclick="openPrePlan('${ev.id}')">🔄 Umplanen</button>
      <button onclick="hideEvent('${ev.id}')">🙈 Ausblenden</button>
      <button onclick="confirmDeleteEvent('${ev.id}')">🗑 Löschen</button>
    </div></div>
    ${more ? `<button class="btn ghost block" onclick="openDrawer()">Weitere geplante Ziele: ${more} ›</button>` : ''}`;
}

/* Kopieren & Teilen */
function eventText(ev) {
  const lines = [ev.title, ...eventFacts(ev).map(([i, t]) => `${i} ${t}`)];
  if (ev.place?.lat) lines.push(`🗺️ https://www.google.com/maps/search/?api=1&query=${ev.place.lat},${ev.place.lon}`);
  return lines.join('\n');
}
async function copyEvent(id) {
  const ev = S.events.find(e => e.id === id); if (!ev) return;
  try { await navigator.clipboard.writeText(eventText(ev)); toast('Kopiert ✓'); }
  catch { openSheet(`<h2>Kopieren</h2><textarea class="input" style="min-height:180px" readonly>${esc(eventText(ev))}</textarea><div class="small muted" style="margin-top:6px">Text lange antippen → „Alles auswählen“ → „Kopieren“.</div>`); }
}
async function shareEvent(id) {
  const ev = S.events.find(e => e.id === id); if (!ev) return;
  if (navigator.share) { try { await navigator.share({ title: ev.title, text: eventText(ev) }); } catch { /* abgebrochen */ } }
  else copyEvent(id);
}

/* Löschen · Ausblenden · Umplanen */
function hideEvent(id) {
  const ev = S.events.find(e => e.id === id); if (!ev) return;
  ev.hidden = true; save(); render();
  openSheet(`<h2>🙈 Ausgeblendet</h2><p>„${esc(ev.title)}“ erscheint nicht mehr auf der Startseite. Du findest es weiter im Tab „Plan“.</p>
    <div class="list"><button class="btn block" onclick="unhideEvent('${id}')">↩︎ Rückgängig</button><button class="btn primary block" onclick="closeSheet()">OK</button></div>`);
}
function unhideEvent(id) { const ev = S.events.find(e => e.id === id); if (ev) { ev.hidden = false; save(); } closeSheet(); render(); toast('Wieder eingeblendet'); }
function confirmDeleteEvent(id) {
  const ev = S.events.find(e => e.id === id); if (!ev) return;
  const linked = S.expenses.filter(x => x.eventId === id).length;
  openSheet(`<h2>🗑 „${esc(ev.title)}“ löschen?</h2>
    <p class="muted">Das Ziel und seine geplante Anreise werden entfernt.${linked ? ` Die ${linked} zugeordneten Belege bleiben unter „Kosten“ erhalten.` : ''} Das kann nicht rückgängig gemacht werden.</p>
    <div class="list"><button class="btn danger block" onclick="doDeleteEvent('${id}')">Endgültig löschen</button>
    <button class="btn block" onclick="closeSheet();hideEvent('${id}')">Lieber nur ausblenden</button></div>`);
}
function doDeleteEvent(id) {
  S.events = S.events.filter(e => e.id !== id);
  S.events.forEach(e => { if (e.after === id) delete e.after; });
  S.expenses.forEach(x => { if (x.eventId === id) x.eventId = null; });
  if (S.active?.eventId === id) S.active = null;
  save(); closeSheet(); render(); toast('Gelöscht');
}

/* ───────────── „Ich bin schon unterwegs“ ───────────── */
function openOnTheWay(id) {
  const ev = S.events.find(e => e.id === id); if (!ev) return;
  const s = season();
  openSheet(`<h2>${s.ride.ico} Wie bist du unterwegs?</h2><div class="muted small">nach ${esc(ev.title)} – ich begleite dich ab hier.</div>
    <div class="bigchoices" style="margin-top:12px">
      <button class="bigchoice" onclick="openRideSetup('${id}')"><div class="ico">🚄</div><b>Im Zug</b><span>Zug wird erkannt</span></button>
      <button class="bigchoice" onclick="startByCar('${id}')"><div class="ico">🚗</div><b>Im Auto</b><span>Fahrzeit & Kilometer</span></button>
      <button class="bigchoice" onclick="closeSheet();openStartSearch('${id}')"><div class="ico">🚌</div><b>Bus / Bahn</b><span>ab meinem Standort</span></button>
      <button class="bigchoice" onclick="startOnFoot('${id}')"><div class="ico">🚶</div><b>Zu Fuß</b><span>mit GPS-Führung</span></button>
    </div>`);
}
async function startByCar(id) {
  const ev = S.events.find(e => e.id === id); if (!ev) return;
  let pos; try { pos = await getPosOnce(); } catch { toast('Bitte Standort erlauben'); return; }
  toast('Berechne Autofahrt…');
  try {
    const r = await planJourney({ lat: pos.lat, lon: pos.lon }, ev.place, { directModes: 'CAR', num: 1, maxDirectTime: 86400 });
    const car = (r.direct || []).find(d => d.legs[0].mode === 'CAR');
    if (!car) { toast('Keine Autoroute gefunden'); return; }
    const leg = { ...car.legs[0], from: { ...car.legs[0].from, name: 'Dein Standort' }, to: { ...car.legs[0].to, name: 'END' } };
    const traffic = await hereCar(pos, ev.place);
    if (traffic) { leg.endTime = new Date(new Date(leg.startTime).getTime() + traffic.duration * 1000).toISOString(); }
    closeSheet();
    startCompanion(ev, { legs: [leg], startTime: leg.startTime, endTime: leg.endTime });
    if (!S.drive) setTimeout(() => openSheet(`<h2>🚗 Kilometer aufzeichnen?</h2><p>Für die Reisekosten kann ich die tatsächlich gefahrenen Kilometer per GPS mitschreiben (App muss offen bleiben).</p>
      <div class="list"><button class="btn primary block" onclick="startDrive()">● Aufzeichnen</button><button class="btn block" onclick="closeSheet()">Nein danke</button>
      <a class="btn block" target="_blank" rel="noopener" href="${esc(googleMaps(ev, 'driving'))}">Navigation in Google Maps ↗</a></div>`), 500);
  } catch (e) { toast('Fehler: ' + e.message); }
}
async function startOnFoot(id) {
  const ev = S.events.find(e => e.id === id); if (!ev) return;
  closeSheet(); startWalkGuide({ lat: ev.place.lat, lon: ev.place.lon, name: ev.place.name || ev.title });
}
