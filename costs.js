/* Reisebegleiter – Reisekosten, Belege, Kilometer, Tracking, Live-Leiste
 * Belegdateien (PDF/Fotos) liegen in IndexedDB auf dem Gerät, die Kostendaten im App-Speicher.
 */
'use strict';

/* ───────────── Belegablage (IndexedDB) ───────────── */
const DOCS = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('reisebegleiter-docs', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async put(id, blob, meta) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put({ blob, ...meta }, id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
  async get(id) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('files').objectStore('files').get(id); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async del(id) { const db = await this.open(); return new Promise(res => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').delete(id); tx.oncomplete = res; }); }
};

S.expenses ||= [];
S.drives ||= [];
S.settings.kmRate ??= 0.30;       // Wegstreckenentschädigung Privat-PKW (DE: 0,30 €/km)
S.settings.perDiemDay ??= 14;     // Verpflegungspauschale > 8 h (DE)
S.settings.perDiemFull ??= 28;    // Verpflegungspauschale 24 h (DE)
S.settings.trackJourney ??= true;

const CAT = {
  ticket: { ico: '🎫', label: 'Ticket (Bahn/Flug/Bus)' },
  hotel: { ico: '🏨', label: 'Hotel' },
  oepnv: { ico: '🚇', label: 'ÖPNV vor Ort' },
  taxi: { ico: '🚕', label: 'Taxi / Uber' },
  km: { ico: '🚗', label: 'Kilometer (eigenes Auto)' },
  car: { ico: '⛽', label: 'Tanken / Mietwagen' },
  parking: { ico: '🅿️', label: 'Parken / Maut' },
  meals: { ico: '🍽️', label: 'Bewirtung / Essen' },
  perdiem: { ico: '📋', label: 'Verpflegungspauschale' },
  other: { ico: '🧾', label: 'Sonstiges' }
};
const eur = n => (Number(n) || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const parseAmount = s => { if (s == null) return 0; s = String(s).replace(/\s/g, ''); if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, ''); return Math.round(parseFloat(s) * 100) / 100 || 0; };

/* ───────────── Beleg erkennen ───────────── */
async function loadPdfJs() {
  if (window.pdfjsLib) return;
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}
async function pdfText(file) {
  await loadPdfJs();
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  let t = '';
  for (let i = 1; i <= Math.min(pdf.numPages, 6); i++) {
    const p = await pdf.getPage(i); const c = await p.getTextContent();
    let lastY = null;
    for (const it of c.items) { const y = Math.round(it.transform[5]); t += (lastY !== null && Math.abs(y - lastY) > 3 ? '\n' : ' ') + it.str; lastY = y; }
    t += '\n';
  }
  return t;
}
async function pdfThumb(file) {
  try {
    await loadPdfJs();
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const p = await pdf.getPage(1); const vp = p.getViewport({ scale: 1.2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c.toDataURL('image/jpeg', .7);
  } catch { return null; }
}
const fileB64 = f => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(f); });

async function extractReceipt(file, statusEl) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const say = t => statusEl && (statusEl.innerHTML = `<div class="row" style="margin-top:10px"><span class="spinner"></span> ${t}</div>`);
  if (S.settings.claudeKey) {
    try {
      say('Claude liest den Beleg…');
      const block = isPdf ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await fileB64(file) } }
        : { type: 'image', source: { type: 'base64', media_type: file.type || 'image/jpeg', data: await fileB64(file) } };
      const ans = await claude([block, { type: 'text', text: 'Lies diesen Beleg aus.' }],
        `Du liest Reisekosten-Belege (Bahntickets, Hotelrechnungen, Taxi/Uber, Tankquittungen, Restaurant, Parken) aus. Antworte NUR mit JSON:
{"category":"ticket|hotel|oepnv|taxi|car|parking|meals|other","vendor":"","date":"YYYY-MM-DD","amount":0.00,"currency":"EUR","vat":0.00,"vatRate":19,"description":"z.B. ICE Frankfurt–Berlin, 1 Nacht","invoiceNo":"","payment":"Karte|bar|Rechnung|''","nights":0}
amount = Bruttobetrag (gesamt). Bei Hotel getrennte Frühstückskosten in description nennen.`, 800);
      const j = JSON.parse(ans.slice(ans.indexOf('{'), ans.lastIndexOf('}') + 1));
      return { category: CAT[j.category] ? j.category : 'other', vendor: j.vendor || '', date: j.date || new Date().toISOString().slice(0, 10), amount: +j.amount || 0, vat: +j.vat || 0, vatRate: +j.vatRate || null, note: [j.description, j.invoiceNo && 'Nr. ' + j.invoiceNo].filter(Boolean).join(' · '), payment: j.payment || '', source: 'claude' };
    } catch (e) { console.warn(e); toast('Claude nicht erreichbar – nutze lokale Erkennung'); }
  }
  let text = '';
  if (isPdf) { say('Lese PDF-Text…'); text = await pdfText(file); }
  else { say('Texterkennung…'); text = await ocr(file, statusEl); }
  return { ...ruleReceipt(text), source: 'lokal', rawText: text.slice(0, 3000) };
}
function ruleReceipt(t) {
  const txt = t.replace(/\r/g, '');
  const low = txt.toLowerCase();
  const amtRe = /(\d{1,3}(?:[.\s]\d{3})*,\d{2}|\d+\.\d{2})\s*(?:€|eur)?/i;
  let amount = 0;
  for (const kw of ['gesamtbetrag', 'gesamtpreis', 'rechnungsbetrag', 'zu zahlen', 'endbetrag', 'summe', 'total', 'gesamt', 'betrag', 'preis']) {
    const i = low.lastIndexOf(kw);
    if (i >= 0) { const m = txt.slice(i, i + 80).match(amtRe); if (m) { amount = parseAmount(m[1]); break; } }
  }
  if (!amount) { const all = [...txt.matchAll(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|eur)/gi)].map(m => parseAmount(m[1])); amount = all.length ? Math.max(...all) : 0; }
  // alle MwSt-Zeilen summieren (Hotel: 7 % Übernachtung + 19 % Frühstück)
  const vatLines = [...txt.matchAll(/(?:mwst|ust|mehrwertsteuer|vat|tax)[^\n]{0,25}?(\d{1,2})\s*%[^\n]{0,20}?(\d{1,3}(?:\.\d{3})*,\d{2})/gi)];
  const vatRates = [...new Set(vatLines.map(m => +m[1]))];
  const vatM = vatLines.length ? [null, vatRates.length === 1 ? vatRates[0] : null, vatLines.reduce((s, m) => s + parseAmount(m[2]), 0).toFixed(2).replace('.', ',')] : null;
  const d = txt.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  const date = d ? `${d[3].length === 2 ? '20' + d[3] : d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}` : new Date().toISOString().slice(0, 10);
  let category = 'other';
  if (/\b(ice|ic|ec|flixtrain|flixbus|bahncard|fahrkarte|ticket|db fernverkehr|deutsche bahn|lufthansa|boarding)\b/i.test(txt)) category = 'ticket';
  if (/(hotel|motel|übernachtung|logis|zimmer|check-?out)/i.test(txt)) category = 'hotel';
  if (/(bvg|mvg|hvv|kvb|rmv|vbb|einzelfahrschein|tageskarte)/i.test(txt)) category = 'oepnv';
  if (/\b(aral|shell|esso|totalenergies|jet tankstelle|tankstelle|diesel|super e10|benzin|sixt|europcar|hertz|avis)\b/i.test(txt)) category = 'car';
  if (/\b(uber|bolt|free ?now|taxi)\b/i.test(txt)) category = 'taxi';
  if (/(parkhaus|parken|parkticket|maut|apcoa|contipark)/i.test(txt)) category = 'parking';
  if (/(restaurant|bistro|café|cafe|speisen|getränke|bewirtung)/i.test(txt) && category === 'other') category = 'meals';
  const vendor = (txt.match(/(Deutsche Bahn|DB Fernverkehr|Motel One|Uber|Bolt|FREENOW|BVG|Aral|Shell|Esso|Sixt|Lufthansa|FlixBus|Ibis|Premier Inn|Meininger|NH Hotel|Mercure)/i)?.[1]) || txt.split('\n').map(s => s.trim()).find(s => s.length > 2 && !/^\d/.test(s))?.slice(0, 40) || '';
  return { category, vendor, date, amount, vat: vatM ? parseAmount(vatM[2]) : 0, vatRate: vatM && vatM[1] != null ? +vatM[1] : null, note: '', payment: /(visa|mastercard|ec-?karte|girocard|kartenzahlung|apple pay)/i.test(txt) ? 'Karte' : /bar\b/i.test(txt) ? 'bar' : '' };
}

/* ───────────── Kosten erfassen (Dialog) ───────────── */
function tripOptions(sel) {
  const evs = [...S.events].sort((a, b) => new Date(b.start || 0) - new Date(a.start || 0));
  return `<option value="">– keiner Reise zugeordnet –</option>` + evs.map(e => `<option value="${e.id}" ${e.id === sel ? 'selected' : ''}>${esc(e.title)}${e.start ? ' · ' + fmtD(e.start) : ''}</option>`).join('');
}
function openExpense(editId, preset = {}) {
  const x = editId ? S.expenses.find(e => e.id === editId) : { category: 'ticket', date: new Date().toISOString().slice(0, 10), amount: '', eventId: S.active?.eventId || nextEvent()?.id || '', attachments: [], ...preset };
  window._expAtt = [...(x.attachments || [])];
  openSheet(`<h2>${editId ? 'Beleg bearbeiten' : 'Kosten erfassen'}</h2>
    ${editId ? '' : `<div class="bigchoices">
      <label class="bigchoice"><div class="ico">📷</div><b>Foto</b><span>Quittung fotografieren</span><input type="file" accept="image/*" capture="environment" class="hidden" id="expCam"></label>
      <label class="bigchoice"><div class="ico">📄</div><b>Datei / PDF</b><span>Ticket, Rechnung</span><input type="file" accept="application/pdf,image/*" multiple class="hidden" id="expFile"></label></div>
      <div id="expStatus"></div><div class="eyebrow" style="margin-top:14px">Angaben prüfen / ergänzen</div>`}
    <label class="f">Kategorie</label>
    <div class="chips" id="catChips">${Object.entries(CAT).map(([k, v]) => `<button class="chip ${k === x.category ? 'on' : ''}" data-c="${k}">${v.ico} ${v.label.split(' (')[0]}</button>`).join('')}</div>
    <div id="kmFields" class="${x.category === 'km' ? '' : 'hidden'}">
      <label class="f">Kilometer</label><input class="input" id="expKm" inputmode="decimal" value="${x.km ?? ''}" placeholder="z. B. 124">
      <div class="small muted" style="margin-top:6px">× ${String(S.settings.kmRate).replace('.', ',')} €/km · <a href="#" onclick="openDrive();return false">per GPS, Tacho oder Route ermitteln</a></div>
    </div>
    <div class="row"><div class="grow"><label class="f">Betrag (brutto) €</label><input class="input" id="expAmt" inputmode="decimal" value="${x.amount !== '' ? String(x.amount).replace('.', ',') : ''}" placeholder="0,00"></div>
      <div style="width:110px"><label class="f">MwSt %</label><select class="input" id="expVatRate">${['', 0, 7, 19].map(v => `<option ${v === (x.vatRate ?? '') ? 'selected' : ''} value="${v}">${v === '' ? '–' : v + ' %'}</option>`).join('')}</select></div></div>
    <label class="f">Datum</label><input class="input" type="date" id="expDate" value="${x.date}">
    <label class="f">Anbieter / Händler</label><input class="input" id="expVendor" value="${esc(x.vendor || '')}" placeholder="z. B. DB Fernverkehr">
    <label class="f">Beschreibung</label><input class="input" id="expNote" value="${esc(x.note || '')}" placeholder="z. B. ICE Frankfurt–Berlin">
    <label class="f">Reise</label><select class="input" id="expTrip">${tripOptions(x.eventId)}</select>
    <label class="f">Bezahlt mit</label><div class="chips" id="payChips">${['Karte', 'bar', 'Firmenkarte', 'Rechnung'].map(p => `<button class="chip ${x.payment === p ? 'on' : ''}" data-p="${p}">${p}</button>`).join('')}</div>
    <div id="expAttList" class="row wrap" style="margin-top:12px"></div>
    ${editId ? `<label class="btn sm" style="margin-top:8px">📎 Datei anhängen<input type="file" accept="application/pdf,image/*" class="hidden" id="expFile"></label>` : ''}
    <button class="btn primary block" style="margin-top:14px" id="expSave">Speichern</button>
    ${editId ? `<button class="btn danger block" style="margin-top:8px" onclick="delExpense('${editId}')">Löschen</button>` : ''}`);
  let cat = x.category, pay = x.payment || '';
  const setCat = c => { cat = c; $$('#catChips .chip').forEach(b => b.classList.toggle('on', b.dataset.c === c)); $('#kmFields').classList.toggle('hidden', c !== 'km'); if (c === 'km') updKm(); };
  const updKm = () => { const km = parseAmount($('#expKm').value); if (km) $('#expAmt').value = (km * S.settings.kmRate).toFixed(2).replace('.', ','); };
  $$('#catChips .chip').forEach(b => b.onclick = () => setCat(b.dataset.c));
  $$('#payChips .chip').forEach(b => b.onclick = () => { pay = b.dataset.p; $$('#payChips .chip').forEach(z => z.classList.toggle('on', z === b)); });
  $('#expKm').oninput = updKm;
  renderAttList();
  const onFiles = async files => {
    for (const f of files) {
      const id = 'f_' + uid();
      const thumb = f.type.startsWith('image/') ? await imgThumb(f) : await pdfThumb(f);
      await DOCS.put(id, f, { name: f.name, type: f.type, thumb });
      window._expAtt.push(id); renderAttList();
      if (!editId) {
        try {
          const r = await extractReceipt(f, $('#expStatus'));
          if (r.amount) $('#expAmt').value = String(r.amount.toFixed(2)).replace('.', ',');
          if (r.date) $('#expDate').value = r.date;
          if (r.vendor) $('#expVendor').value = r.vendor;
          if (r.note) $('#expNote').value = r.note;
          if (r.vatRate != null && [0, 7, 19].includes(r.vatRate)) $('#expVatRate').value = r.vatRate;
          if (r.payment) { pay = r.payment; $$('#payChips .chip').forEach(z => z.classList.toggle('on', z.dataset.p === pay)); }
          setCat(r.category);
          const evMatch = S.events.find(e => e.start && dayKey(e.start) === r.date); if (evMatch) $('#expTrip').value = evMatch.id;
          $('#expStatus').innerHTML = `<div class="okbox">Erkannt (${r.source === 'claude' ? 'Claude' : 'lokal'}): ${CAT[r.category].ico} ${esc(r.vendor || '')} ${r.amount ? eur(r.amount) : '– Betrag bitte eintragen'}</div>`;
        } catch (e) { $('#expStatus').innerHTML = `<div class="warnbox">Konnte nicht automatisch lesen – bitte Felder ausfüllen. (${esc(e.message)})</div>`; }
      }
    }
  };
  ['#expCam', '#expFile'].forEach(s => { const i = $(s); if (i) i.onchange = e => onFiles([...e.target.files]); });
  $('#expSave').onclick = () => {
    const amount = parseAmount($('#expAmt').value);
    if (!amount && cat !== 'km') { toast('Bitte Betrag eintragen'); return; }
    const vr = $('#expVatRate').value === '' ? null : +$('#expVatRate').value;
    const data = { category: cat, amount, date: $('#expDate').value, vendor: $('#expVendor').value.trim(), note: $('#expNote').value.trim(), eventId: $('#expTrip').value || null, payment: pay, vatRate: vr, vat: vr ? +(amount - amount / (1 + vr / 100)).toFixed(2) : 0, attachments: window._expAtt, km: cat === 'km' ? parseAmount($('#expKm').value) : undefined, from: x.from, to: x.to, track: x.track };
    if (editId) Object.assign(x, data); else S.expenses.push({ id: uid(), created: new Date().toISOString(), ...data });
    save(); closeSheet(); toast('Beleg gespeichert ✓'); if (currentView === 'kosten') renderKosten();
  };
}
async function imgThumb(f) {
  const url = URL.createObjectURL(f); const img = new Image(); img.src = url; await img.decode().catch(() => { });
  const k = Math.min(1, 480 / Math.max(img.width || 1, img.height || 1)); const c = document.createElement('canvas');
  c.width = (img.width || 1) * k; c.height = (img.height || 1) * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
  return c.toDataURL('image/jpeg', .7);
}
async function renderAttList() {
  const box = $('#expAttList'); if (!box) return;
  const items = await Promise.all((window._expAtt || []).map(async id => ({ id, d: await DOCS.get(id) })));
  box.innerHTML = items.filter(i => i.d).map(i => `<button class="att" onclick="openDoc('${i.id}')">${i.d.thumb ? `<img src="${i.d.thumb}" alt="">` : '📄'}<span>${esc((i.d.name || 'Beleg').slice(0, 18))}</span></button>`).join('');
}
async function openDoc(id) { const d = await DOCS.get(id); if (d) window.open(URL.createObjectURL(d.blob), '_blank'); }
async function delExpense(id) {
  if (!confirm('Beleg löschen? Die angehängte Datei wird ebenfalls entfernt.')) return;
  const x = S.expenses.find(e => e.id === id); for (const a of x?.attachments || []) await DOCS.del(a);
  S.expenses = S.expenses.filter(e => e.id !== id); save(); closeSheet(); renderKosten();
}

/* ───────────── Kilometer: GPS-Fahrtenbuch, Tacho, Route ───────────── */
function openDrive() {
  const d = S.drive;
  openSheet(`<h2>🚗 Gefahrene Kilometer</h2>
    <div class="card flat"><b>1 · Per GPS aufzeichnen</b><div class="small muted">Misst die tatsächlich gefahrene Strecke. Die App muss dabei geöffnet bleiben (Bildschirm bleibt an, iPhone z. B. in die Halterung) – iOS stoppt Web-Apps im Hintergrund.</div>
      ${d ? `<div class="okbox">Läuft seit ${fmtT(d.start)} · ${fmtKm(d.dist)}</div><button class="btn danger block" style="margin-top:8px" onclick="stopDrive()">■ Aufzeichnung beenden & als Beleg speichern</button>`
      : `<button class="btn primary block" style="margin-top:8px" onclick="startDrive()">● Aufzeichnung starten</button>`}</div>
    <div class="card flat"><b>2 · Tachostand</b><div class="row" style="margin-top:8px"><input class="input" id="odoA" inputmode="numeric" placeholder="Start km"><input class="input" id="odoB" inputmode="numeric" placeholder="Ende km"></div><button class="btn block" style="margin-top:8px" onclick="odoSave()">Übernehmen</button></div>
    <div class="card flat"><b>3 · Strecke berechnen</b><div class="small muted">Kürzeste Autoroute zwischen zwei Orten (Hin- & Rückfahrt wählbar).</div>
      <input class="input" id="rtA" placeholder="Von (Adresse / Ort)" style="margin-top:8px" autocomplete="off"><div id="rtAS"></div>
      <input class="input" id="rtB" placeholder="Nach" style="margin-top:8px" autocomplete="off"><div id="rtBS"></div>
      <label class="row small" style="margin-top:8px"><input type="checkbox" id="rtRet"> Hin- und Rückfahrt</label>
      <button class="btn block" style="margin-top:8px" id="rtGo">Berechnen</button><div id="rtOut"></div></div>`);
  let A = null, B = null;
  placeAutocomplete($('#rtA'), $('#rtAS'), p => A = p); placeAutocomplete($('#rtB'), $('#rtBS'), p => B = p);
  $('#rtGo').onclick = async () => {
    if (!A || !B) { toast('Bitte beide Orte wählen'); return; }
    $('#rtOut').innerHTML = '<div class="row" style="margin-top:8px"><span class="spinner"></span> berechne…</div>';
    try {
      const r = await planJourney({ lat: A.lat, lon: A.lon }, { lat: B.lat, lon: B.lon }, { directModes: 'CAR', num: 1, maxDirectTime: 86400 });
      let km = (r.direct?.find(x => x.legs[0].mode === 'CAR')?.legs[0].distance || haversine(A, B) * 1.3) / 1000;
      if ($('#rtRet').checked) km *= 2;
      km = Math.round(km * 10) / 10;
      openExpense(null, { category: 'km', km, amount: +(km * S.settings.kmRate).toFixed(2), note: `${A.name} → ${B.name}${$('#rtRet').checked ? ' und zurück' : ''} (Route)`, from: A.name, to: B.name });
    } catch (e) { $('#rtOut').innerHTML = `<div class="badbox">${esc(e.message)}</div>`; }
  };
}
function odoSave() {
  const a = parseAmount($('#odoA').value), b = parseAmount($('#odoB').value);
  if (!(b > a)) { toast('Ende muss größer als Start sein'); return; }
  const km = Math.round((b - a) * 10) / 10;
  openExpense(null, { category: 'km', km, amount: +(km * S.settings.kmRate).toFixed(2), note: `Tacho ${a} → ${b} km` });
}
async function startDrive() {
  try { await getPosOnce(); } catch { toast('Standortfreigabe nötig'); return; }
  S.drive = { start: new Date().toISOString(), dist: 0, pts: [], startPos: GPS.pos ? { lat: GPS.pos.lat, lon: GPS.pos.lon } : null };
  save(); keepAwake(true); startGPS(); closeSheet(); renderLive();
  feed('Autofahrt wird aufgezeichnet', 'Lass die App geöffnet. Ich zähle die tatsächlich gefahrenen Kilometer und lege am Ende einen Kilometer-Beleg an.', 'ok');
}
async function stopDrive() {
  const d = S.drive; if (!d) return;
  S.drive = null; save(); if (!S.active) keepAwake(false);
  const km = Math.round(d.dist / 100) / 10;
  const [a, b] = await Promise.all([revGeo(d.startPos), revGeo(GPS.pos)]);
  const drv = { id: uid(), start: d.start, end: new Date().toISOString(), km, from: a, to: b, pts: d.pts.filter((_, i) => i % 3 === 0) };
  S.drives.push(drv); save(); renderLive();
  openExpense(null, { category: 'km', km, amount: +(km * S.settings.kmRate).toFixed(2), note: `${a || 'Start'} → ${b || 'Ziel'} (GPS ${fmtT(drv.start)}–${fmtT(drv.end)})`, from: a, to: b, track: drv.id, date: drv.start.slice(0, 10) });
}
async function revGeo(p) {
  if (!p) return '';
  try { const r = await getJSON(`https://nominatim.openstreetmap.org/reverse?${qs({ lat: p.lat, lon: p.lon, format: 'json', zoom: 16, 'accept-language': 'de' })}`); const a = r.address || {}; return [a.road && (a.road + (a.house_number ? ' ' + a.house_number : '')), a.city || a.town || a.village].filter(Boolean).join(', '); } catch { return ''; }
}

/* GPS-Spur: Autofahrt + Reisebegleitung (Rauschen & Sprünge werden gefiltert) */
let lastTrackPt = null;
function trackPoint(p) {
  if (!p || p.acc > 60) return;
  if (lastTrackPt) {
    const d = haversine(lastTrackPt, p), dt = (p.t - lastTrackPt.t) / 3600000;
    if (d < 20) return;                         // Stillstand/Rauschen
    if (dt > 0 && d / 1000 / dt > 320) return;  // unplausibler Sprung
    if (S.drive) S.drive.dist += d;
    if (S.active && S.settings.trackJourney) S.active.trackDist = (S.active.trackDist || 0) + d;
  }
  lastTrackPt = p;
  if (S.drive) { S.drive.pts.push([+p.lat.toFixed(5), +p.lon.toFixed(5)]); }
  if (S.active && S.settings.trackJourney) { (S.active.track ||= []).push([+p.lat.toFixed(5), +p.lon.toFixed(5), Math.round(p.t / 1000)]); if (S.active.track.length > 3000) S.active.track.splice(0, 1000); }
  if ((S.drive || S.active) && !trackPoint._s) { trackPoint._s = setTimeout(() => { save(); trackPoint._s = null; renderLive(); }, 15000); }
}

/* Nach Reiseende: an Belege erinnern */
function remindReceipts(ev) {
  const has = S.expenses.filter(x => x.eventId === ev.id);
  const missing = [!has.some(x => x.category === 'ticket') && 'Ticket', ev.kind === 'hotel' && !has.some(x => x.category === 'hotel') && 'Hotelrechnung (beim Check-out)'].filter(Boolean);
  const km = S.active?.trackDist ? ` Per GPS bist du ${fmtKm(S.active.trackDist)} gereist.` : '';
  if (missing.length) feed('Belege nicht vergessen', `Für „${ev.title}“ fehlt noch: ${missing.join(', ')}. Foto oder PDF genügt – ich lese Betrag & Datum aus.${km}`, 'info', { action: 'addReceipt', push: false });
}

/* ───────────── Kosten-Tab ───────────── */
let costFilter = '';
function renderKosten() {
  const el = $('#view-kosten');
  const list = S.expenses.filter(x => !costFilter || x.eventId === costFilter).sort((a, b) => b.date.localeCompare(a.date));
  const sum = list.reduce((s, x) => s + (+x.amount || 0), 0), vat = list.reduce((s, x) => s + (+x.vat || 0), 0);
  const byCat = Object.keys(CAT).map(k => ({ k, v: list.filter(x => x.category === k).reduce((s, x) => s + (+x.amount || 0), 0) })).filter(c => c.v > 0).sort((a, b) => b.v - a.v);
  const km = list.filter(x => x.category === 'km').reduce((s, x) => s + (+x.km || 0), 0);
  let h = `<div class="hero" style="background:radial-gradient(120% 140% at 100% 0%,#18c3a6 0%,transparent 55%),linear-gradient(135deg,#0f766e,#134e4a)">
    <div class="eyebrow">Reisekosten ${costFilter ? '· ' + esc(S.events.find(e => e.id === costFilter)?.title || '') : 'gesamt'}</div>
    <div class="big" style="margin-top:6px">${eur(sum)}</div>
    <div class="sub" style="margin-top:6px">${list.length} Belege · davon MwSt ${eur(vat)}${km ? ` · ${String(km.toFixed(1)).replace('.', ',')} km` : ''}</div>
    ${sum ? `<div class="stack">${byCat.map(c => `<i title="${CAT[c.k].label}" style="flex:${c.v};background:${catColor(c.k)}"></i>`).join('')}</div><div class="row wrap small" style="gap:4px 12px;margin-top:8px">${byCat.map(c => `<span><b style="color:${catColor(c.k)}">●</b> ${CAT[c.k].ico} ${eur(c.v)}</span>`).join('')}</div>` : ''}
    <div class="row wrap" style="margin-top:14px"><button class="btn primary" onclick="openExpense()">＋ Beleg</button><button class="btn" onclick="openDrive()">🚗 Kilometer${S.drive ? ' ●' : ''}</button><button class="btn" onclick="openReport()">📤 Bericht</button></div></div>
    <select class="input" onchange="costFilter=this.value;renderKosten()">${tripOptions(costFilter).replace('– keiner Reise zugeordnet –', 'Alle Reisen')}</select>`;
  if (!list.length) h += `<div class="empty"><div class="ico">🧾</div>Noch keine Belege. Fotografiere eine Quittung oder lade ein Ticket-PDF hoch – Betrag, Datum und Anbieter werden automatisch übernommen.</div>`;
  let lastDay = null;
  for (const x of list) {
    if (x.date !== lastDay) { h += `<div class="daylabel">${new Date(x.date + 'T12:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })}</div>`; lastDay = x.date; }
    h += `<div class="item" onclick="openExpense('${x.id}')"><div class="ic">${CAT[x.category]?.ico || '🧾'}</div><div class="grow"><b class="ellipsis" style="display:block">${esc(x.vendor || CAT[x.category]?.label)}</b><div class="small muted ellipsis">${esc(x.note || '')}${x.category === 'km' ? ` ${String(x.km).replace('.', ',')} km` : ''}</div></div><div class="when">${eur(x.amount)}<div class="small muted">${x.attachments?.length ? '📎 Beleg' : (x.category === 'km' || x.category === 'perdiem') ? '' : '<span style="color:var(--warn)">kein Beleg</span>'}</div></div></div>`;
  }
  if (costFilter) {
    const ev = S.events.find(e => e.id === costFilter);
    h += `<div class="card"><b>Verpflegungspauschale</b><div class="small muted">Für Dienstreisen in DE: ${eur(S.settings.perDiemDay)} (> 8 h bzw. An-/Abreisetag), ${eur(S.settings.perDiemFull)} (24 h). Mahlzeiten, die gestellt wurden (z. B. Hotelfrühstück), mindern die Pauschale.</div>
      <div class="row wrap" style="margin-top:8px"><button class="btn sm" onclick="addPerDiem('${costFilter}',${S.settings.perDiemDay})">+ ${eur(S.settings.perDiemDay)}</button><button class="btn sm" onclick="addPerDiem('${costFilter}',${S.settings.perDiemFull})">+ ${eur(S.settings.perDiemFull)}</button></div></div>`;
    void ev;
  }
  el.innerHTML = h;
}
const catColor = k => ({ ticket: '#ec0016', hotel: '#8578ff', oepnv: '#0ea5e9', taxi: '#f59e0b', km: '#22c55e', car: '#14b8a6', parking: '#64748b', meals: '#f97316', perdiem: '#a3e635', other: '#94a3b8' }[k]);
function addPerDiem(evId, v) {
  S.expenses.push({ id: uid(), created: new Date().toISOString(), category: 'perdiem', amount: v, date: new Date().toISOString().slice(0, 10), vendor: 'Verpflegungspauschale', note: v >= S.settings.perDiemFull ? 'voller Tag (24 h)' : 'An-/Abreisetag bzw. > 8 h', eventId: evId, attachments: [], vat: 0 });
  save(); renderKosten(); toast('Pauschale hinzugefügt');
}

/* ───────────── Bericht (PDF über Drucken, CSV) ───────────── */
function openReport() {
  openSheet(`<h2>📤 Reisekostenbericht</h2>
    <label class="f">Reise</label><select class="input" id="repTrip">${tripOptions(costFilter).replace('– keiner Reise zugeordnet –', 'Alle Reisen')}</select>
    <label class="f">Name (erscheint im Bericht)</label><input class="input" id="repName" value="${esc(S.settings.reportName || '')}" placeholder="optional">
    <label class="f">Anlass / Zweck</label><input class="input" id="repPurpose" placeholder="z. B. Kundentermin Berlin">
    <div class="list" style="margin-top:14px">
      <button class="btn primary block" onclick="makeReport('view')">📄 Bericht mit Belegen anzeigen (→ als PDF sichern)</button>
      <button class="btn block" onclick="makeReport('share')">Bericht teilen (Mail, Dateien…)</button>
      <button class="btn block" onclick="makeReport('csv')">Tabelle (CSV für Excel/DATEV)</button>
    </div>
    <div class="small muted" style="margin-top:10px">PDF: Bericht öffnen → Teilen → „Drucken“ → mit zwei Fingern aufziehen → als PDF sichern.</div>`);
}
async function makeReport(mode) {
  const evId = $('#repTrip').value, name = $('#repName').value.trim(), purpose = $('#repPurpose').value.trim();
  S.settings.reportName = name; save();
  const ev = S.events.find(e => e.id === evId);
  const list = S.expenses.filter(x => !evId || x.eventId === evId).sort((a, b) => a.date.localeCompare(b.date));
  const fname = `Reisekosten_${(ev?.title || 'alle').replace(/[^\wäöüß-]+/gi, '_')}_${new Date().toISOString().slice(0, 10)}`;
  if (mode === 'csv') {
    const rows = [['Datum', 'Kategorie', 'Anbieter', 'Beschreibung', 'Reise', 'Kilometer', 'Betrag brutto', 'MwSt-Satz', 'MwSt', 'Netto', 'Zahlart', 'Beleg']];
    list.forEach(x => rows.push([x.date, CAT[x.category]?.label, x.vendor, x.note, S.events.find(e => e.id === x.eventId)?.title || '', x.km ?? '', x.amount.toFixed(2).replace('.', ','), x.vatRate ?? '', (x.vat || 0).toFixed(2).replace('.', ','), ((x.amount || 0) - (x.vat || 0)).toFixed(2).replace('.', ','), x.payment || '', x.attachments?.length ? 'ja' : 'nein']));
    const csv = '﻿' + rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    return shareOrDownload(new File([csv], fname + '.csv', { type: 'text/csv' }));
  }
  const total = list.reduce((s, x) => s + x.amount, 0), vat = list.reduce((s, x) => s + (x.vat || 0), 0);
  const docs = [];
  for (const x of list) for (const a of x.attachments || []) { const d = await DOCS.get(a); if (d) docs.push({ x, d, src: d.type?.startsWith('image/') ? await blobToDataURL(d.blob) : d.thumb }); }
  const byCat = Object.keys(CAT).map(k => [k, list.filter(x => x.category === k).reduce((s, x) => s + x.amount, 0)]).filter(c => c[1]);
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(fname)}</title><style>
body{font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:820px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{padding:6px 5px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase;color:#666}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.tot td{font-weight:700;border-top:2px solid #111}.meta{color:#555}.doc{page-break-inside:avoid;margin:18px 0;border:1px solid #ddd;border-radius:8px;padding:10px}.doc img{max-width:100%;max-height:900px;display:block;margin-top:8px}.sig{margin-top:40px;display:flex;gap:40px}.sig div{flex:1;border-top:1px solid #111;padding-top:4px;color:#555}@media print{.doc{page-break-before:always}}</style></head><body>
<h1>Reisekostenabrechnung</h1><div class="meta">${name ? esc(name) + ' · ' : ''}${ev ? esc(ev.title) + (ev.start ? ' · ' + fmtD(ev.start) : '') : 'Alle Reisen'}${purpose ? '<br>Anlass: ' + esc(purpose) : ''}<br>Erstellt am ${new Date().toLocaleDateString('de-DE')}</div>
<table><tr><th>Datum</th><th>Art</th><th>Anbieter / Beschreibung</th><th class="n">MwSt</th><th class="n">Betrag</th><th>Beleg</th></tr>
${list.map((x, i) => `<tr><td>${new Date(x.date + 'T12:00').toLocaleDateString('de-DE')}</td><td>${CAT[x.category]?.label}</td><td>${esc(x.vendor)}${x.note ? '<br><span class="meta">' + esc(x.note) + '</span>' : ''}${x.category === 'km' ? `<br><span class="meta">${String(x.km).replace('.', ',')} km × ${String(S.settings.kmRate).replace('.', ',')} €</span>` : ''}</td><td class="n">${x.vat ? eur(x.vat) + (x.vatRate ? ` (${x.vatRate} %)` : '') : '–'}</td><td class="n">${eur(x.amount)}</td><td>${x.attachments?.length ? 'Anlage ' + (i + 1) : (x.category === 'km' || x.category === 'perdiem' ? '–' : 'fehlt')}</td></tr>`).join('')}
<tr class="tot"><td colspan="3">Summe</td><td class="n">${eur(vat)}</td><td class="n">${eur(total)}</td><td></td></tr></table>
<table style="width:auto;margin-top:18px">${byCat.map(([k, v]) => `<tr><td>${CAT[k].label}</td><td class="n">${eur(v)}</td></tr>`).join('')}</table>
<div class="sig"><div>Datum, Unterschrift Reisende:r</div><div>Geprüft / genehmigt</div></div>
${docs.map(({ x, d, src }) => `<div class="doc"><b>Anlage ${list.indexOf(x) + 1}</b> · ${esc(x.vendor || '')} · ${eur(x.amount)} · ${esc(d.name || '')}${src ? `<img src="${src}" alt="">` : '<div class="meta">(PDF-Datei – im Original beifügen)</div>'}</div>`).join('')}
</body></html>`;
  const file = new File([html], fname + '.html', { type: 'text/html' });
  if (mode === 'share') return shareOrDownload(file);
  const w = window.open(URL.createObjectURL(file), '_blank'); if (!w) shareOrDownload(file);
}
const blobToDataURL = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
async function shareOrDownload(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: file.name }); return; } catch { /* abgebrochen */ } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
}

/* ───────────── Live-Leiste & Assistenz-Bubble (auf jedem Screen) ───────────── */
function renderLive() {
  const bar = $('#liveBar'), bud = $('#buddy');
  if (!bar) return;
  const parts = [];
  if (S.active) {
    const it = S.active.itinerary, ev = activeEvent(), now = Date.now();
    const cur = it.legs.find(l => isTransit(l) && new Date(l.startTime) <= now && new Date(l.endTime) >= now);
    const nx = it.legs.find(l => isTransit(l) && !l._void && new Date(l.startTime) > now);
    const d = cur ? delayOf(cur.to.arrival, cur.to.scheduledArrival) : nx ? delayOf(nx.from.departure, nx.from.scheduledDeparture) : 0;
    const what = cur ? `${modeIcon(cur.mode)} ${esc(legName(cur))} → ${esc(cur.to.name.replace(/^S\+U |\(Berlin\)/g, ''))} ${fmtT(cur.endTime)}` : nx ? `⏱ ${esc(legName(nx))} ${fmtT(nx.startTime)}${nx.from.track ? ' Gl. ' + esc(nx.from.track) : ''}` : '🏁 letzte Meile';
    parts.push(`<span class="ellipsis grow">${what}${d > 0 ? ` <b class="lb-late">+${d}</b>` : ''}</span><span class="lb-eta">${KIND[ev?.kind]?.ico || '🏁'} ${fmtT(itinEnd(it))}</span>`);
  }
  if (S.drive) parts.push(`<span class="lb-rec">● ${fmtKm(S.drive.dist)}</span>`);
  bar.innerHTML = parts.join('');
  bar.classList.toggle('hidden', !parts.length);
  bud.classList.toggle('hidden', !S.active && !S.drive);
}
function showBuddy(m) {
  const b = $('#buddyBubble'); if (!b || !m) return;
  b.innerHTML = `<b>${esc(m.title || 'Hinweis')}</b><div>${esc((m.body || '').split('\n')[0])}</div>`;
  b.className = 'buddy-bubble ' + (m.level || '');
  clearTimeout(showBuddy._t); showBuddy._t = setTimeout(() => b.classList.add('hidden'), 9000);
}
