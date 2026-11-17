/* Reisebegleiter – Hotel-Schritt bei der Reiseplanung
 * 1) Eigene Seite: „Brauchst du ein Hotel?“  2) Filter (Datum, Personen, Lage, Preis, Sterne, Extras)
 * 3) Hotels in der Nähe des Ziels + Booking.com-Suche mit allen Filtern  4) Preisvergleich Booking ↔ direkt
 * 5) Buchung per Link (Bezahlung immer auf der Seite des Anbieters) → sofort als Reise-Etappe gespeichert.
 * Hinweis: Booking.com hat keine offene Schnittstelle – Preise kommen von den Seiten, die du öffnest.
 */
'use strict';

const isoDate = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
let HF = null; // aktuelle Hotelsuche

function hotelNeeded(ev) {
  // schon ein Hotel in der Nähe, das die Nacht abdeckt?
  return !S.events.some(h => h.kind === 'hotel' && h.id !== ev.id && h.place?.lat && haversine(h.place, ev.place) < 30000 &&
    (!h.start || !ev.start || Math.abs(new Date(h.start) - new Date(ev.start)) < 2 * 86400e3));
}
function openHotelStep(evId) {
  const ev = S.events.find(e => e.id === evId); if (!ev) return;
  openSheet(`<h2>🏨 Brauchst du ein Hotel?</h2>
    <div class="muted small">${esc(ev.title)}${ev.start ? ' · ' + fmtD(ev.start) + ', ' + fmtT(ev.start) : ''} · ${esc(ev.place.address || ev.place.name || '')}</div>
    <div class="bigchoices" style="margin-top:14px">
      <button class="bigchoice" onclick="openHotelFilters('${ev.id}')"><div class="ico">🔎</div><b>Ja, Hotel suchen</b><span>in der Nähe des Ziels</span></button>
      <button class="bigchoice" onclick="window._nextAfter=null;closeSheet();openAdd()"><div class="ico">✅</div><b>Habe schon eins</b><span>Hotel eintragen</span></button>
      <button class="bigchoice" onclick="closeSheet();toast('Alles klar – ohne Hotel')"><div class="ico">🚫</div><b>Nein</b><span>Tagesreise</span></button>
    </div>`);
}
function openHotelFilters(evId) {
  const ev = S.events.find(e => e.id === evId);
  const st = ev.start ? new Date(ev.start) : new Date(Date.now() + 86400e3);
  const ci = new Date(st); if (st.getHours() < 12) ci.setDate(ci.getDate() - 1); // morgens Termin → Nacht davor
  const co = ev.end && new Date(ev.end).toDateString() !== ci.toDateString() ? new Date(ev.end) : new Date(ci.getTime() + 86400e3);
  const f = S.hotelPrefs || { radius: 2000, price: 150, stars: 0, breakfast: false, cancel: true, review: true, adults: 1, rooms: 1 };
  openSheet(`<h2>🏨 Hotel finden</h2><div class="muted small">nahe ${esc(ev.place.name || ev.title)}</div>
    <div class="row"><div class="grow"><label class="f">Anreise</label><input class="input" type="date" id="hfIn" value="${isoDate(ci)}"></div>
    <div class="grow"><label class="f">Abreise</label><input class="input" type="date" id="hfOut" value="${isoDate(co)}"></div></div>
    <div class="row"><div class="grow"><label class="f">Personen</label><select class="input" id="hfAd">${[1, 2, 3, 4].map(n => `<option ${n === f.adults ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    <div class="grow"><label class="f">Zimmer</label><select class="input" id="hfRo">${[1, 2, 3].map(n => `<option ${n === f.rooms ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div>
    <label class="f">Entfernung zum Ziel</label><div class="chips" data-g="radius">${[[1000, '≤ 1 km'], [2000, '≤ 2 km'], [5000, '≤ 5 km']].map(([v, l]) => `<button class="chip ${f.radius === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>
    <label class="f">Preis pro Nacht bis</label><div class="chips" data-g="price">${[[100, '100 €'], [150, '150 €'], [200, '200 €'], [0, 'egal']].map(([v, l]) => `<button class="chip ${f.price === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>
    <label class="f">Sterne ab</label><div class="chips" data-g="stars">${[[0, 'egal'], [3, '3 ★'], [4, '4 ★']].map(([v, l]) => `<button class="chip ${f.stars === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>
    <label class="f">Extras</label><div class="chips">
      <button class="chip ${f.breakfast ? 'on' : ''}" data-t="breakfast">🥐 Frühstück</button>
      <button class="chip ${f.cancel ? 'on' : ''}" data-t="cancel">↩︎ Kostenlos stornierbar</button>
      <button class="chip ${f.review ? 'on' : ''}" data-t="review">⭐ Bewertung 8+</button></div>
    <button class="btn primary block" style="margin-top:16px" id="hfGo">Hotels suchen</button>`);
  $$('[data-g]').forEach(g => $$('.chip', g).forEach(b => b.onclick = () => { f[g.dataset.g] = +b.dataset.v; $$('.chip', g).forEach(x => x.classList.toggle('on', x === b)); }));
  $$('[data-t]').forEach(b => b.onclick = () => { f[b.dataset.t] = !f[b.dataset.t]; b.classList.toggle('on', f[b.dataset.t]); });
  $('#hfGo').onclick = () => {
    Object.assign(f, { adults: +$('#hfAd').value, rooms: +$('#hfRo').value });
    S.hotelPrefs = { ...f }; save();
    HF = { ev, f, checkin: $('#hfIn').value, checkout: $('#hfOut').value };
    searchHotels();
  };
}
function bookingUrl(q) {
  const { ev, f, checkin, checkout } = HF;
  const nflt = [f.price && `price=EUR-min-${f.price}-1`, f.stars && `class=${f.stars}`, f.stars === 3 && 'class=4', f.stars && 'class=5', f.review && 'review_score=80', f.cancel && 'fc=2', f.breakfast && 'mealplan=1', !q && `distance=${f.radius}`].filter(Boolean).join(';');
  const base = { checkin, checkout, group_adults: f.adults, no_rooms: f.rooms, group_children: 0, lang: 'de', selected_currency: 'EUR' };
  const where = q ? { ss: q } : { ss: cityOf(ev) || ev.place.name, dest_type: 'latlong', latitude: ev.place.lat, longitude: ev.place.lon, order: 'distance_from_search' };
  return `https://www.booking.com/searchresults.de.html?${qs({ ...where, ...base, nflt })}`;
}
const nights = () => Math.max(1, Math.round((new Date(HF.checkout) - new Date(HF.checkin)) / 86400e3));
const googleHotelsUrl = name => `https://www.google.com/travel/search?${qs({ q: `${name} ${cityOf(HF.ev)}`.trim(), hl: 'de' })}`;
const hotelSiteUrl = h => h.website || `https://www.google.com/search?${qs({ q: `${h.name} ${cityOf(HF.ev)} offizielle Website direkt buchen` })}`;

async function searchHotels() {
  const { ev, f } = HF;
  openSheet(`<h2>🏨 Hotels nahe ${esc(ev.place.name || ev.title)}</h2>
    <div class="muted small">${new Date(HF.checkin).toLocaleDateString('de-DE')} – ${new Date(HF.checkout).toLocaleDateString('de-DE')} · ${nights()} Nacht/Nächte · ${f.adults} Pers.</div>
    <a class="btn primary block" style="margin-top:12px" target="_blank" rel="noopener" href="${esc(bookingUrl())}" onclick="markHotelLook('Booking.com')">Auf Booking.com suchen – alle Filter übernommen ↗</a>
    <div class="small muted" style="margin-top:6px">Booking zeigt die echten Preise & Verfügbarkeit. Gefällt dir ein Hotel, such es unten oder tippe auf „Anderes Hotel“.</div>
    <div id="hList"><div class="row" style="margin-top:12px"><span class="spinner"></span> Suche Hotels in der Nähe…</div></div>
    <button class="btn ghost block" onclick="pickOtherHotel()">Anderes Hotel eingeben (z. B. von Booking)</button>`);
  const found = await nearbyHotels(ev.place, f.radius);
  HF.list = found;
  const box = $('#hList'); if (!box) return;
  box.innerHTML = found.length ? `<label class="f">In der Nähe (${found.length})</label><div class="list">${found.slice(0, 12).map((h, k) => `
    <div class="card flat" style="margin:0"><div class="spread"><b>${esc(h.name)}</b><span class="small muted">${fmtKm(h.d)}</span></div>
      <div class="small muted">${esc(h.address || '')}${h.stars ? ' · ' + '★'.repeat(Math.min(5, +h.stars || 0)) : ''} · ca. ${Math.max(1, Math.round(h.d * 1.3 / 80))} Min zu Fuß</div>
      <div class="row wrap" style="margin-top:8px;gap:6px"><button class="btn sm primary" onclick="chooseHotel(${k})">Auswählen</button>
      <a class="btn sm" target="_blank" rel="noopener" href="${esc(bookingUrl(h.name + ', ' + (cityOf(ev) || '')))}">Booking ↗</a>
      <a class="btn sm" target="_blank" rel="noopener" href="${esc(googleHotelsUrl(h.name))}">Preise vergleichen ↗</a></div></div>`).join('')}</div>`
    : `<div class="warnbox" style="margin-top:10px">Keine Hotels im Umkreis gefunden – nutze die Booking-Suche oben oder vergrößere den Umkreis.</div>`;
}
async function nearbyHotels(p, radius) {
  const out = new Map();
  const add = (name, lat, lon, extra = {}) => { if (!name) return; const d = haversine(p, { lat, lon }); if (d > radius) return; const k = normKey(name); const o = out.get(k); out.set(k, { ...(o || {}), name, lat, lon, d, ...extra }); };
  // Photon: mehrere Suchbegriffe, weil „Motel One“, „Adina“ usw. nicht „Hotel“ heißen
  await Promise.all(['hotel', 'motel', 'hostel', 'inn', 'apartments', 'suites'].map(async q => {
    try {
      const r = await getJSON(`https://photon.komoot.io/api/?${qs({ q, lat: p.lat, lon: p.lon, limit: 25, lang: 'de', osm_tag: 'tourism:hotel' })}`);
      for (const x of r.features || []) { const pr = x.properties; add(pr.name, x.geometry.coordinates[1], x.geometry.coordinates[0], { address: [[pr.street, pr.housenumber].filter(Boolean).join(' '), pr.city].filter(Boolean).join(', ') }); }
    } catch { }
  }));
  // OSM-Details (Sterne, Website) – nur wenn schnell verfügbar
  const ov = await withTimeout(9000, overpass(`[out:json][timeout:15];nwr(around:${radius},${p.lat},${p.lon})[tourism=hotel][name];out center 60;`));
  for (const e of ov?.elements || []) { const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon; add(e.tags.name, lat, lon, { stars: e.tags.stars, website: e.tags.website || e.tags['contact:website'], address: [e.tags['addr:street'], e.tags['addr:housenumber']].filter(Boolean).join(' ') || undefined }); }
  const f = HF?.f || {};
  return [...out.values()].filter(h => !f.stars || !h.stars || +h.stars >= f.stars).sort((a, b) => a.d - b.d);
}
function pickOtherHotel() {
  openSheet(`<h2>Anderes Hotel</h2><div class="muted small">Name oder Adresse – z. B. das Hotel, das du auf Booking gefunden hast.</div>
    <input class="input" id="ohIn" style="margin-top:10px" placeholder="Hotelname, Ort" autocomplete="off"><div id="ohS"></div>`);
  placeAutocomplete($('#ohIn'), $('#ohS'), p => { HF.list = [{ name: p.name, lat: p.lat, lon: p.lon, address: p.address, d: haversine(HF.ev.place, p) }, ...(HF.list || [])]; chooseHotel(0); }, true);
}

/* Preisvergleich & Buchung */
function chooseHotel(k) {
  const h = HF.list[k]; HF.hotel = h;
  const n = nights();
  openSheet(`<h2>🏨 ${esc(h.name)}</h2>
    <div class="muted small">${esc(h.address || '')} · ${fmtKm(h.d)} zum Ziel · ${new Date(HF.checkin).toLocaleDateString('de-DE')} – ${new Date(HF.checkout).toLocaleDateString('de-DE')} (${n} N.)</div>
    <div class="card flat"><b>1 · Preise ansehen</b>
      <div class="row wrap" style="margin-top:8px;gap:6px">
        <a class="btn sm" target="_blank" rel="noopener" href="${esc(bookingUrl(h.name + ', ' + (cityOf(HF.ev) || '')))}">Booking.com ↗</a>
        <a class="btn sm" target="_blank" rel="noopener" href="${esc(hotelSiteUrl(h))}">Hotel-Website ↗</a>
        <a class="btn sm" target="_blank" rel="noopener" href="${esc(googleHotelsUrl(h.name))}">Google-Preisvergleich ↗</a></div>
      <div class="small muted" style="margin-top:6px">Der Google-Preisvergleich zeigt oft Booking, andere Portale und die offizielle Hotel-Website nebeneinander.</div></div>
    <div class="card flat"><b>2 · Gesamtpreise eintragen</b>
      <div class="row"><div class="grow"><label class="f">Booking €</label><input class="input" id="pB" inputmode="decimal" placeholder="z. B. 129"></div>
      <div class="grow"><label class="f">Direkt €</label><input class="input" id="pD" inputmode="decimal" placeholder="z. B. 119"></div></div>
      <div id="pCmp" class="small" style="margin-top:8px"></div></div>
    <div class="card flat"><b>3 · Buchen</b><div class="small muted">Die Buchung und Bezahlung erfolgen auf der Seite des Anbieters – ich speichere die Reise gleich mit.</div>
      <div class="list" style="margin-top:8px">
        <button class="btn primary block" id="bkB">Bei Booking buchen ↗</button>
        <button class="btn block" id="bkD">Direkt beim Hotel buchen ↗</button>
        <button class="btn ghost block" id="bkL">Nur vormerken (noch nicht gebucht)</button></div></div>`);
  const cmp = () => {
    const b = parseAmount($('#pB').value), d = parseAmount($('#pD').value), el = $('#pCmp');
    if (!b || !d) { el.innerHTML = '<span class="muted">Tipp: Viele Hotels sind direkt gleich teuer oder günstiger (Bestpreis-Garantie, Mitgliederrate) – Portale bieten oft flexiblere Stornierung.</span>'; return; }
    const diff = Math.round((b - d) * 100) / 100;
    el.innerHTML = diff > 0 ? `<div class="okbox">Direkt ist ${eur(diff)} günstiger (${eur(d / nights())} statt ${eur(b / nights())} pro Nacht). Stornobedingungen vergleichen!</div>`
      : diff < 0 ? `<div class="okbox">Booking ist ${eur(-diff)} günstiger. Tipp: Beim Hotel nach Preisangleich fragen.</div>` : '<div class="okbox">Gleicher Preis – direkt buchen bringt oft Extras (Frühstück, Upgrade, späterer Check-out).</div>';
    $('#bkB').classList.toggle('primary', diff <= 0); $('#bkD').classList.toggle('primary', diff > 0);
  };
  $('#pB').oninput = $('#pD').oninput = cmp; cmp();
  const go = via => {
    const price = via === 'Booking.com' ? parseAmount($('#pB').value) : via === 'direkt' ? parseAmount($('#pD').value) : 0;
    const hev = saveHotelStage(via, price);
    if (via !== 'vorgemerkt') {
      S.pendingBooking = { evId: hev.id, via, at: Date.now() }; save();
      window.open(via === 'Booking.com' ? bookingUrl(h.name + ', ' + (cityOf(HF.ev) || '')) : hotelSiteUrl(h), '_blank');
    }
  };
  $('#bkB').onclick = () => go('Booking.com'); $('#bkD').onclick = () => go('direkt'); $('#bkL').onclick = () => go('vorgemerkt');
}
/* Hotel sofort als Etappe der Reise speichern (Termin startet danach vom Hotel aus) */
function saveHotelStage(via, price) {
  const { ev, hotel: h, checkin, checkout } = HF;
  const ci = new Date(`${checkin}T15:00`), co = new Date(`${checkout}T11:00`);
  const hev = { id: uid(), kind: 'hotel', title: h.name, place: { name: h.name, address: h.address || '', lat: h.lat, lon: h.lon, type: 'HOTEL' }, start: ci.toISOString(), end: co.toISOString(), checkIn: '15:00',
    notes: `${via === 'vorgemerkt' ? 'Vorgemerkt – noch nicht gebucht' : 'Buchung über ' + via}${price ? ' · ' + eur(price) + ' gesamt' : ''}`, booking: { via, price: price || null, status: via === 'vorgemerkt' ? 'vorgemerkt' : 'offen' } };
  hev.trip = ev.trip || ev.id; ev.trip = hev.trip;
  if (ci < new Date(ev.start || 0)) {
    // Termin am Folgetag startet jetzt vom Hotel: alte Anreise (z. B. ab Köln über Nacht) wird zur Anreise zum Hotel,
    // der Weg Hotel → Termin wird automatisch geplant (beides bleibt änderbar)
    ev.after = hev.id; delete ev.plan;
    const by = ev.arriveBy ? new Date(ev.arriveBy) : new Date(new Date(ev.start).getTime() - 15 * 60e3);
    planTo(ev, { lat: h.lat, lon: h.lon, name: h.name }, by, true).then(its => {
      const best = bySafety(its.filter(i => new Date(itinEnd(i)) <= by))[0];
      if (best) { ev.plan = { origin: { lat: h.lat, lon: h.lon, name: h.name }, mode: 'arr', time: by.toISOString(), itinerary: best, savedAt: new Date().toISOString() }; save(); render(); }
    }).catch(() => { });
  } else hev.after = ev.id;
  // die Anreise zum Termin am Folgetag vom Hotel aus vorplanen lassen (Start bleibt änderbar)
  S.events.push(hev); save(); closeSheet();
  feed('Hotel gespeichert', `${h.name} · ${new Date(checkin).toLocaleDateString('de-DE')} – ${new Date(checkout).toLocaleDateString('de-DE')} · ${via === 'vorgemerkt' ? 'vorgemerkt' : 'Buchung über ' + via}. Ist Teil deiner Reise „${ev.title}“.`, 'ok', { push: false });
  toast('Hotel als Etappe gespeichert ✓'); render();
  // Anreise zum Hotel vorschlagen – Start wie bei der bisherigen Planung, jederzeit änderbar
  if (ci < new Date(ev.start || 0)) feed('Anreise zum Hotel planen?', `Du übernachtest im ${h.name}. Soll ich die Anreise dorthin planen? Den Startort kannst du jederzeit ändern.`, 'info', { action: 'preplan', evId: hev.id, push: false });
  if (via === 'vorgemerkt' && ci < new Date(ev.start || 0)) setTimeout(() => openPrePlan(hev.id, ev.plan?.origin ? { origin: ev.plan.origin, mode: 'arr', time: ci.toISOString() } : null), 400);
  return hev;
}
function markHotelLook() { /* nur Information – keine Daten werden an Booking übermittelt außer den Suchfiltern im Link */ }
/* Zurück von der Buchungsseite → nachfragen und Kosten anlegen */
function checkBookingReturn() {
  const b = S.pendingBooking; if (!b || document.hidden || Date.now() - b.at < 60e3) return;
  if ($('#sheet') && !$('#sheet').classList.contains('hidden')) return;
  const hev = S.events.find(e => e.id === b.evId); if (!hev) { S.pendingBooking = null; save(); return; }
  openSheet(`<h2>🏨 Hast du gebucht?</h2><div class="muted small">${esc(hev.title)} · über ${esc(b.via)}</div>
    <div class="row"><div class="grow"><label class="f">Buchungsnummer</label><input class="input" id="bnr"></div><div class="grow"><label class="f">Preis gesamt €</label><input class="input" id="bpr" inputmode="decimal" value="${hev.booking?.price ? String(hev.booking.price).replace('.', ',') : ''}"></div></div>
    <div class="list" style="margin-top:12px"><button class="btn primary block" id="bYes">Ja, gebucht – speichern</button>
    <button class="btn block" id="bNo">Noch nicht – vormerken</button></div>`);
  $('#bYes').onclick = () => {
    const price = parseAmount($('#bpr').value), nr = $('#bnr').value.trim();
    hev.booking = { ...(hev.booking || {}), status: 'gebucht', price, nr };
    hev.notes = `Gebucht über ${b.via}${nr ? ' · Nr. ' + nr : ''}${price ? ' · ' + eur(price) : ''}`;
    if (price) S.expenses.push({ id: uid(), created: new Date().toISOString(), category: 'hotel', amount: price, date: hev.start.slice(0, 10), vendor: hev.title, note: `${b.via}${nr ? ' · Nr. ' + nr : ''} (Rechnung folgt beim Check-out)`, eventId: hev.id, attachments: [], vat: 0 });
    S.pendingBooking = null; save(); closeSheet(); toast('Buchung gespeichert ✓'); render();
  };
  $('#bNo').onclick = () => { hev.booking.status = 'vorgemerkt'; S.pendingBooking = null; save(); closeSheet(); };
}
document.addEventListener('visibilitychange', () => setTimeout(checkBookingReturn, 900));
