/* Reisebegleiter – Anreise vorab planen
 * Einfach gehalten: Start wählen (Standort / Zuhause / zuletzt genutzt / beliebiger Ort), „Ankommen bis“, Verbindung antippen.
 * Jederzeit änderbar. Am Reisetag wird die geplante Verbindung live abgeglichen, mit Losgeh-Erinnerung.
 */
'use strict';

S.recentOrigins ||= [];

function openPrePlan(evId, preset = null) {
  const ev = S.events.find(e => e.id === evId); if (!ev) return;
  const p = preset || ev.plan || {};
  // „spätestens dort“ = exakt diese Zeit; sonst 15 Min Puffer vor Beginn
  const def = p.time ? new Date(p.time) : ev.arriveBy ? new Date(ev.arriveBy) : ev.start ? new Date(new Date(ev.start).getTime() - 15 * 60e3) : new Date(Date.now() + 3600e3);
  const anchor = S.events.find(e => e.id === ev.after);
  const origins = [
    ...(anchor ? [{ k: 'anc', label: `${KIND[anchor.kind]?.ico || '📍'} ${anchor.place.name || anchor.title}`, place: { ...anchor.place, name: anchor.place.name || anchor.title } }] : []),
    { k: 'gps', label: '📍 Mein Standort' },
    ...(S.settings.home ? [{ k: 'home', label: `🏠 ${S.settings.home.name}`, place: S.settings.home }] : []),
    ...S.recentOrigins.filter(o => !S.settings.home || o.name !== S.settings.home.name).slice(0, 3).map((o, i) => ({ k: 'r' + i, label: '🕘 ' + o.name, place: o }))
  ];
  let origin = p.origin || (anchor ? origins[0].place : null), mode = p.mode || (ev.start ? 'arr' : 'dep');
  const selKey = origin ? (origins.find(o => o.place && o.place.name === origin.name)?.k || 'custom') : 'gps';
  openSheet(`<h2>🧭 Anreise planen</h2>
    <div class="muted small">${KIND[ev.kind]?.ico || '📍'} ${esc(ev.title)}${ev.start ? ' · ' + fmtD(ev.start) + ', ' + fmtT(ev.start) : ''}</div>
    <label class="f">Von wo?</label>
    <div class="chips" id="ppO">${origins.map(o => `<button class="chip ${o.k === selKey ? 'on' : ''}" data-k="${o.k}">${esc(o.label)}</button>`).join('')}</div>
    <input class="input" id="ppIn" style="margin-top:8px" placeholder="…oder anderen Ort / Bahnhof eingeben" value="${selKey === 'custom' ? esc(origin.name) : ''}" autocomplete="off"><div id="ppS"></div>
    <label class="row small hidden" id="ppHomeRow" style="margin-top:6px"><input type="checkbox" id="ppHome"> Als „Zuhause“ merken</label>
    <label class="f">Wann?</label>
    <div class="seg" id="ppM"><button data-m="arr" class="${mode === 'arr' ? 'on' : ''}">Ankommen bis</button><button data-m="dep" class="${mode === 'dep' ? 'on' : ''}">Losfahren um</button></div>
    <input class="input" type="datetime-local" id="ppT" style="margin-top:8px" value="${localInputValue(def)}">
    ${ev.arriveBy ? `<div class="small muted" style="margin-top:4px">Du musst spätestens um ${fmtT(ev.arriveBy)} dort sein – ich zeige nur Verbindungen, die das sicher schaffen.</div>` : ev.start ? `<div class="small muted" style="margin-top:4px">Vorschlag: 15 Min vor Beginn – bei Bedarf ändern.</div>` : ''}
    ${anchor ? `<div class="small" style="margin-top:4px">🧳 Etappe deiner Reise – Start ist „${esc(anchor.place.name || anchor.title)}“, jederzeit änderbar.</div>` : ''}
    <button class="btn primary block" style="margin-top:14px" id="ppGo">Verbindungen suchen</button>
    <div id="ppR"></div>`);
  $$('#ppO .chip').forEach(b => b.onclick = () => {
    $$('#ppO .chip').forEach(x => x.classList.toggle('on', x === b)); $('#ppIn').value = ''; $('#ppHomeRow').classList.add('hidden');
    const o = origins.find(o => o.k === b.dataset.k); origin = o.place || null;
  });
  placeAutocomplete($('#ppIn'), $('#ppS'), pl => { origin = pl; $$('#ppO .chip').forEach(x => x.classList.remove('on')); $('#ppHomeRow').classList.remove('hidden'); });
  segBind('#ppM', b => mode = b.dataset.m);
  $('#ppGo').onclick = async () => {
    const box = $('#ppR'); box.innerHTML = '<div class="row" style="margin-top:12px"><span class="spinner"></span> Suche Verbindungen…</div>';
    try {
      let o = origin;
      if (!o) { const g = await getPosOnce(); o = { lat: g.lat, lon: g.lon, name: 'Mein Standort' }; }
      const t = new Date($('#ppT').value);
      const its = bySafety((await planTo(ev, o, t, mode === 'arr')).filter(i => mode !== 'arr' || new Date(itinEnd(i)) <= t)).slice(0, 4)
        .sort((a, b) => mode === 'arr' ? new Date(b.legs[0].startTime) - new Date(a.legs[0].startTime) : new Date(itinEnd(a)) - new Date(itinEnd(b)));
      if (!its.length) { box.innerHTML = '<div class="warnbox">Keine Verbindung gefunden – anderen Start oder andere Zeit probieren.</div>'; return; }
      window._pp = { ev, o, t: t.toISOString(), mode, its };
      box.innerHTML = `<label class="f">Tippe auf deine Verbindung</label><div class="list">${its.map((it, k) => `<div class="card flat" style="margin:0;cursor:pointer" onclick="savePrePlan(${k})">${itinSummary(it)}</div>`).join('')}</div>`;
    } catch (e) { box.innerHTML = `<div class="badbox">${esc(e.message || 'Standort nicht verfügbar')}</div>`; }
  };
}
function savePrePlan(k) {
  const { ev, o, t, mode, its } = window._pp;
  ev.plan = { origin: o, mode, time: t, itinerary: structuredClone(its[k]), savedAt: new Date().toISOString(), reminded: false };
  if (o.name !== 'Mein Standort') {
    S.recentOrigins = [o, ...S.recentOrigins.filter(r => r.name !== o.name)].slice(0, 5);
    if ($('#ppHome')?.checked) S.settings.home = o;
  }
  save(); closeSheet(); toast('Anreise gespeichert ✓ – jederzeit änderbar'); render();
  // Nächster Schritt der Reiseplanung: weite Anreise und noch kein Hotel → eigene Seite „Hotel?“
  if (ev.kind !== 'hotel' && o.lat && haversine(o, ev.place) > 80000 && hotelNeeded(ev)) setTimeout(() => openHotelStep(ev.id), 400);
}
function removePrePlan(evId) { const ev = S.events.find(e => e.id === evId); if (ev) { delete ev.plan; save(); closeSheet(); render(); } }

/* Kurzansicht der geplanten Anreise */
function prePlanLine(ev) {
  const it = ev.plan?.itinerary; if (!it) return '';
  const f = it.legs.find(isTransit);
  return `🧭 ab ${fmtT(it.legs[0].startTime)} ${esc(ev.plan.origin?.name || '')}${f ? ' · ' + esc(legName(f)) : ''} · an ${fmtT(itinEnd(it))}`;
}
function prePlanCard(ev) {
  if (!ev.plan) return `<button class="btn block" onclick="openPrePlan('${ev.id}')">🧭 Anreise vorab planen</button>`;
  const it = ev.plan.itinerary, f = it.legs.find(isTransit);
  return `<div class="card flat" style="margin:0"><div class="spread"><b>🧭 Geplante Anreise</b><span class="small muted">ab ${esc(ev.plan.origin?.name || '')}</span></div>
    <div style="margin-top:6px">${itinSummary(it)}</div>
    ${f ? `<div class="meta">Erster Abschnitt: ${esc(legName(f))} ${fmtT(f.startTime)} ab ${esc(f.from.name)}${f.from.track ? ', Gl. ' + esc(f.from.track) : ''}</div>` : ''}
    <div class="row" style="margin-top:8px"><button class="btn sm" onclick="openPrePlan('${ev.id}')">Ändern</button><button class="btn sm ghost" onclick="removePrePlan('${ev.id}')">Entfernen</button></div></div>`;
}

/* Start der Begleitung mit Vorplanung */
async function startFromPlan(evId) {
  const ev = S.events.find(e => e.id === evId); if (!ev?.plan) return openStartSearch(evId);
  closeSheet();
  const it = structuredClone(ev.plan.itinerary);
  const firstT = it.legs.find(isTransit);
  if (firstT && new Date(firstT.startTime).getTime() < Date.now() - 3 * 60e3) {
    // geplante Verbindung schon weg → nächste ab demselben Start (oder Standort) suchen
    toast('Geplante Verbindung ist schon weg – suche die nächste…');
    try {
      let o = ev.plan.origin;
      if (!o || o.name === 'Mein Standort') { const g = await getPosOnce(); o = { lat: g.lat, lon: g.lon, name: 'Mein Standort' }; }
      const best = bySafety(await planTo(ev, o, new Date(), false))[0];
      if (!best) { toast('Keine Verbindung gefunden'); return; }
      notify(null, 'Neue Verbindung', `Die geplante Verbindung ist abgefahren. Nächste sichere Verbindung: ab ${fmtT(best.legs[0].startTime)} – Ankunft ${fmtT(itinEnd(best))}.`, 'warn');
      return startCompanion(ev, best);
    } catch (e) { toast('Fehler: ' + e.message); return; }
  }
  startCompanion(ev, it);
}
function openStartChoice(evId) {
  const ev = S.events.find(e => e.id === evId); if (!ev) return;
  if (!ev.plan) return openStartSearch(evId);
  openSheet(`<h2>Begleitung starten</h2><div class="muted small">${esc(ev.title)}</div>
    <div class="list" style="margin-top:12px">
      <button class="btn primary block" onclick="startFromPlan('${ev.id}')">▶︎ Geplante Anreise nutzen<br><span class="small" style="font-weight:500">${prePlanLine(ev)}</span></button>
      <button class="btn block" onclick="closeSheet();openStartSearch('${ev.id}')">Andere Verbindung suchen</button>
      <button class="btn block" onclick="closeSheet();openRideSetup('${ev.id}')">🚄 Ich sitze schon im Zug</button>
    </div>`);
}

/* Erinnerung & Vorab-Check am Reisetag (läuft, solange die App offen ist) */
async function checkPlanned() {
  if (S.active) return;
  const now = Date.now();
  for (const ev of S.events.filter(e => e.plan && !e.done)) {
    const it = ev.plan.itinerary, dep = new Date(it.legs[0].startTime).getTime();
    if (dep < now - 30 * 60e3 || dep - now > 4 * 3600e3) continue;
    // alle 10 Min: geplante Fahrten live prüfen (Ausfall? gravierende Verspätung?)
    if (!ev.plan.checkedAt || now - new Date(ev.plan.checkedAt).getTime() > 10 * 60e3) {
      ev.plan.checkedAt = new Date().toISOString();
      for (const l of it.legs.filter(isTransit)) { try { await refreshLeg(l); } catch { } }
      const bad = it.legs.find(l => isTransit(l) && l.cancelled);
      const late = it.legs.filter(isTransit).reduce((m, l) => Math.max(m, delayOf(l.to.arrival, l.to.scheduledArrival)), 0);
      if (bad && !ev.plan.warnedCxl) { ev.plan.warnedCxl = true; notify(null, `Geplante Fahrt fällt aus: ${legName(bad)}`, `Für „${ev.title}“ solltest du neu planen.`, 'bad', { action: 'preplan', evId: ev.id }); }
      else if (late >= S.settings.interveneDelay && !ev.plan.warnedLate) { ev.plan.warnedLate = true; notify(null, `Geplante Verbindung +${late} Min`, `Ankunft bei „${ev.title}“ voraussichtlich ${fmtT(itinEnd(it))}. Andere Verbindung suchen?`, 'warn', { action: 'preplan', evId: ev.id }); }
      save();
    }
    const lead = Math.max(15, Math.round((new Date(it.legs[0].endTime) - new Date(it.legs[0].startTime)) / 60e3) + 10); // Fußweg zur Haltestelle + Puffer
    if (!ev.plan.reminded && dep - now < lead * 60e3 && dep > now) {
      ev.plan.reminded = true; save();
      const f = it.legs.find(isTransit);
      notify(null, `In ${mins(dep - now)} Min losgehen`, `Nach „${ev.title}“${f ? `: ${legName(f)} um ${fmtT(f.startTime)} ab ${f.from.name}${f.from.track ? ', Gleis ' + f.from.track : ''}` : ''}.`, 'info', { action: 'startPlan', evId: ev.id });
    }
  }
}
setInterval(checkPlanned, 60000);
setTimeout(checkPlanned, 5000);
