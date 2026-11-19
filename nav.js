/* Reisebegleiter – Bedienung: Wischen zum Schließen, Schutz der laufenden Begleitung, Übersichts-Seitenfenster */
'use strict';

/* ───────────── Fenster durch Wischen nach unten schließen ───────────── */
(function swipeToClose() {
  const sheet = $('#sheet'); let y0 = null, dy = 0, dragging = false;
  sheet.addEventListener('touchstart', e => {
    if (e.target.closest('.map, .leaflet-container, input, textarea, select')) return;
    // vom Kopf aus immer; aus dem Inhalt nur, wenn ganz nach oben gescrollt
    if (!e.target.closest('#sheetHead') && sheet.scrollTop > 0) return;
    y0 = e.touches[0].clientY; dy = 0; dragging = false;
  }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 8) { dragging = true; sheet.style.transition = 'none'; sheet.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (y0 == null) return; y0 = null; sheet.style.transition = 'transform .2s';
    if (dragging && dy > 110) { sheet.style.transform = 'translateY(100%)'; setTimeout(closeSheet, 180); }
    else sheet.style.transform = '';
  });
})();
/* Aufgeklappte Listen (z. B. Zwischenhalte): nach unten wischen klappt sie wieder zu */
document.addEventListener('touchstart', e => { const d = e.target.closest('details[open]'); if (d) d._y = e.touches[0].clientY; }, { passive: true });
document.addEventListener('touchend', e => { const d = e.target.closest('details[open]'); if (d && d._y != null && e.changedTouches[0].clientY - d._y > 90) d.open = false; if (d) d._y = null; });

/* ───────────── Laufende Begleitung schützen ───────────── */
function guardCompanion(ev, itinerary, ride) {
  const cur = activeEvent();
  window._guard = { ev, itinerary, ride };
  openSheet(`<h2>Begleitung läuft gerade</h2>
    <p>Ich begleite dich gerade${cur ? ` nach <b>${esc(cur.title)}</b> (Ankunft ${fmtT(itinEnd(S.active.itinerary))})` : ''}. Die neue Planung für <b>${esc(ev.title)}</b> unterbricht das nicht.</p>
    <div class="list">
      <button class="btn primary block" onclick="guardKeep()">Laufende Begleitung behalten<br><span class="small" style="font-weight:500">neue Verbindung wird beim Termin gespeichert</span></button>
      <button class="btn danger block" id="gSwitch">Laufende beenden & neu starten</button>
    </div>`);
  $('#gSwitch').onclick = () => {
    const b = $('#gSwitch');
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Sicher? Nochmal tippen zum Bestätigen'; return; }
    const g = window._guard; closeSheet(); startCompanion(g.ev, g.itinerary, g.ride, true);
  };
}
function guardKeep() {
  const { ev, itinerary } = window._guard || {};
  if (ev && itinerary && !ev.plan) { ev.plan = { origin: { name: itinerary.legs[0]?.from?.name || 'Start', lat: itinerary.legs[0]?.from?.lat, lon: itinerary.legs[0]?.from?.lon }, mode: 'dep', time: itinerary.legs[0]?.startTime, itinerary, savedAt: new Date().toISOString() }; save(); }
  closeSheet(); toast('Begleitung läuft weiter ✓'); go('jetzt');
}

/* ───────────── Seitenfenster „Übersicht“ ───────────── */
function openDrawer() { renderDrawer(); $('#drawer').classList.remove('hidden'); $('#drawerBackdrop').classList.remove('hidden'); }
function closeDrawer() { $('#drawer').classList.add('hidden'); $('#drawerBackdrop').classList.add('hidden'); }
(function swipeDrawer() {
  const d = $('#drawer'); let x0 = null;
  d.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  d.addEventListener('touchend', e => { if (x0 != null && x0 - e.changedTouches[0].clientX > 70) closeDrawer(); x0 = null; });
})();

/* Orte, zu denen man zurückkehren oder von denen man starten kann */
function collectPlaces() {
  const out = new Map();
  const add = (p, kind, sub) => { if (!p?.lat || !p.name || p.name === 'START' || p.name === 'END') return; const k = normKey(p.name); if (!out.has(k)) out.set(k, { name: p.name, address: p.address || '', lat: p.lat, lon: p.lon, stopId: p.stopId, kind, sub }); };
  const evs = [...S.events, ...(S.archive || []).map(a => a.event).filter(Boolean)];
  evs.filter(e => e.kind === 'hotel').sort((a, b) => new Date(b.start || 0) - new Date(a.start || 0)).forEach(e => add(e.place, 'hotel', e.start ? fmtD(e.start) : ''));
  const its = [S.active?.itinerary, ...S.events.map(e => e.plan?.itinerary)].filter(Boolean);
  its.forEach(it => it.legs.filter(isTransit).forEach(l => { add({ ...l.from, name: l.from.name }, 'stop', legName(l)); add({ ...l.to, name: l.to.name }, 'stop', legName(l)); }));
  (S.recentOrigins || []).forEach(p => add(p, p.stopId ? 'stop' : 'place', 'zuletzt genutzt'));
  Object.values(S.placeAliases || {}).forEach(p => add(p, 'place', 'gemerkt'));
  evs.filter(e => e.kind !== 'hotel').forEach(e => add(e.place, 'place', e.title));
  return [...out.values()];
}
let drawerTab = 'plan';
function renderDrawer() {
  const A = S.active, ev = A ? activeEvent() : null;
  const isPast = e => e.done || (e.start && new Date(e.end || e.start).getTime() < Date.now() - 6 * 3600e3);
  const upcoming = S.events.filter(e => !isPast(e) && e.id !== A?.eventId).sort((a, b) => new Date(a.start || 8.64e15) - new Date(b.start || 8.64e15));
  const past = [...S.events.filter(e => isPast(e) && e.id !== A?.eventId), ...(S.archive || []).map(a => ({ ...a.event, _arch: a.id, title: a.title }))].sort((a, b) => new Date(b.start || 0) - new Date(a.start || 0)).slice(0, 15);
  const places = collectPlaces();
  const item = (ico, title, sub, onclick) => `<button class="dr-item" onclick="${onclick}"><span class="dr-ico">${ico}</span><span class="grow"><b class="ellipsis" style="display:block">${esc(title)}</b>${sub ? `<span class="small muted ellipsis" style="display:block">${sub}</span>` : ''}</span><span class="wp-chev" style="color:var(--muted)">›</span></button>`;
  let h = `<div class="dr-head"><b>Übersicht</b><button class="btn ghost sm" onclick="closeDrawer()">Schließen</button></div>
    <div class="seg" style="margin:0 12px 10px">${[['plan', 'Planung'], ['past', 'Verlauf'], ['places', 'Orte']].map(([k, l]) => `<button class="${drawerTab === k ? 'on' : ''}" onclick="drawerTab='${k}';renderDrawer()">${l}</button>`).join('')}</div><div class="dr-body">`;
  if (drawerTab === 'plan') {
    if (A && ev) h += `<div class="eyebrow dr-l">Läuft gerade</div>` + item('🟢', ev.title, `Ankunft ${fmtT(itinEnd(A.itinerary))} · Begleitung aktiv`, "closeDrawer();go('jetzt')");
    h += `<div class="eyebrow dr-l">Geplant</div>` + (upcoming.map(e => item(KIND[e.kind]?.ico || '📍', e.title, `${e.start ? fmtD(e.start) + ', ' + fmtT(e.start) : 'ohne Zeit'}${e.plan ? ' · ' + prePlanLine(e).replace(/^🧭 /, '') : ''}`, `closeDrawer();openEvent('${e.id}')`)).join('') || '<div class="small muted dr-l">Nichts geplant.</div>');
  } else if (drawerTab === 'past') {
    h += past.map(e => item(e._arch ? '🗄️' : '✓', e.title, `${e.start ? fmtD(e.start) : ''} · ${esc(e.place?.name || '')}`, e._arch ? `closeDrawer();openArchived('${e._arch}')` : `closeDrawer();openEvent('${e.id}')`)).join('') || '<div class="small muted dr-l">Noch keine vergangenen Reisen.</div>';
  } else {
    const grp = (k, label, ico) => { const l = places.filter(p => p.kind === k).slice(0, 10); return l.length ? `<div class="eyebrow dr-l">${label}</div>` + l.map(p => item(ico, p.name, esc(p.sub || p.address || ''), `openPlaceActions('${encodeURIComponent(JSON.stringify(p))}')`)).join('') : ''; };
    h += grp('hotel', 'Hotels', '🏨') + grp('stop', 'Haltestellen & Bahnhöfe', '🚉') + grp('place', 'Orte', '📍') || '<div class="small muted dr-l">Noch keine Orte.</div>';
  }
  $('#drawer').innerHTML = h + '</div>';
}
/* Ort antippen: dorthin zurückkehren oder von dort starten */
function openPlaceActions(enc) {
  const p = JSON.parse(decodeURIComponent(enc)); closeDrawer();
  openSheet(`<h2>${p.kind === 'hotel' ? '🏨' : p.kind === 'stop' ? '🚉' : '📍'} ${esc(p.name)}</h2><div class="muted small">${esc(p.address || p.sub || '')}</div>
    <div class="list" style="margin-top:14px">
      <button class="btn primary block" onclick="goToPlace('${enc}')">🧭 Dorthin – Weg planen</button>
      ${p.kind === 'stop' ? `<button class="btn block" onclick="closeSheet();openStopFinder({mode:'BUS',displayName:'',headsign:'',from:${esc(JSON.stringify({ name: p.name, lat: p.lat, lon: p.lon, stopId: p.stopId }))},to:{name:''},startTime:new Date().toISOString(),endTime:new Date().toISOString()})">📍 Haltestelle auf der Karte</button>` : ''}
      <button class="btn block" onclick="startFromPlace('${enc}')">▶︎ Nächste Planung hier starten</button>
      <a class="btn block" target="_blank" rel="noopener" href="${esc(googleWalk(p))}">In Google Maps öffnen ↗</a>
    </div>`);
}
function goToPlace(enc) {
  const p = JSON.parse(decodeURIComponent(enc));
  // vorhandenen Eintrag nutzen, sonst einen schlichten Ziel-Eintrag anlegen (ohne laufende Begleitung zu stören)
  let ev = S.events.find(e => !e.done && e.place?.name === p.name);
  if (!ev) { ev = { id: uid(), kind: p.kind === 'hotel' ? 'hotel' : 'ort', title: p.name, place: { name: p.name, address: p.address, lat: p.lat, lon: p.lon, stopId: p.stopId }, start: null }; S.events.push(ev); save(); }
  closeSheet(); openStart(ev.id);
}
function startFromPlace(enc) {
  const p = JSON.parse(decodeURIComponent(enc));
  S.recentOrigins = [{ name: p.name, address: p.address, lat: p.lat, lon: p.lon, stopId: p.stopId }, ...(S.recentOrigins || []).filter(r => r.name !== p.name)].slice(0, 5);
  save(); closeSheet(); toast(`„${p.name}“ steht bei der nächsten Planung als Start bereit`);
}
