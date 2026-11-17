/* Reisebegleiter – Reise-Archiv
 * - Archivieren auf Nachfrage, mit Titel, Anlass und Organisationen
 * - Aufbewahrung mind. 30 Tage (wählbar 30 Tage … unbegrenzt), danach automatisches Aufräumen
 * - Gemeinsamkeiten clustern (gleiche Begriffe, Organisationen, Orte)
 * - Wiederkehrender Anlass → Nachfrage, ob „Anlass“ Sortierkriterium wird
 */
'use strict';

S.archive ||= [];
S.archivePrefs ||= { sortBy: 'date', reasonCriterion: null };
const MIN_KEEP_DAYS = 30;
const STOPWORDS = new Set('aber alle allem auch auf aus bei beim bis das dass dem den der des die ein eine einem einen einer eines für gegen hier ihr ihre ins ist mit nach nicht noch oder ohne sich sie sind über und uns unter vom von vor war wie wir zum zur zwischen reise reisen termin hotel bahnhof hauptbahnhof heute morgen abend ankunft abfahrt ticket fahrt tage nacht nächte check zimmer straße strasse platz deutschland'.split(' '));
const NOT_ORG = new Set(['ICE', 'IC', 'EC', 'RE', 'RB', 'DB', 'MWST', 'EUR', 'PDF', 'GPS', 'ÖPNV', 'BVG', 'UTC', 'CET', 'AG', 'SE', 'KG', 'GMBH', 'MBH', 'EV', 'GBR', 'OHG', 'UG', 'NR', 'TEL', 'FAX', 'USt', 'UST', 'IBAN', 'BIC']);

function normText(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, ' '); }
function terms(text) { return [...new Set(normText(text).split(/[\s-]+/).filter(w => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)))]; }
function detectOrgs(text) {
  const t = String(text || ''), out = new Set();
  for (const m of t.matchAll(/([A-ZÄÖÜ][\wÄÖÜäöüß&.\-]+(?:[ \t]+[A-ZÄÖÜ&][\wÄÖÜäöüß&.\-]+){0,3})[ \t]+(GmbH|AG|SE|KG|KGaA|e\.\s?V\.|mbH|Stiftung|Verband|Institut)\b/g)) out.add(`${m[1]} ${m[2]}`.trim());
  for (const m of t.matchAll(/\b(Universität|Hochschule|Fachhochschule|Klinikum|Ministerium|Stadt|Kreis|Messe|Kammer)[ \t]+([A-ZÄÖÜ][\wÄÖÜäöüß\-]+)/g)) out.add(`${m[1]} ${m[2]}`);
  for (const m of t.matchAll(/\b([A-ZÄÖÜ]{2,6})\b/g)) if (!NOT_ORG.has(m[1])) out.add(m[1]);
  for (const m of t.matchAll(/\b(Motel One|Premier Inn|Ibis|Meininger|NH Hotel|Mercure|Novotel|Hilton|Marriott|Lufthansa|Deutsche Bahn)\b/gi)) out.add(m[1]);
  // Teilbegriffe weglassen, wenn sie in einem längeren Treffer stecken (z. B. „IFA“ in „Messe IFA“)
  const all = [...out];
  return all.filter(o => !all.some(p => p !== o && p.toLowerCase().includes(o.toLowerCase()) && !/^(RWTH|TU|FH)$/.test(o)));
}
const sameReason = (a, b) => {
  const A = new Set(terms(a)), B = new Set(terms(b));
  if (!A.size || !B.size) return normText(a).trim() === normText(b).trim() && !!normText(a).trim();
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / Math.min(A.size, B.size) >= 0.6;
};
const cityOf = ev => (ev?.place?.address || '').match(/\d{5}\s+([^,]+)/)?.[1]?.trim() || (ev?.place?.address || '').split(',').pop()?.trim() || '';

/* ───────────── Archivieren (Dialog) ───────────── */
function askArchive(evId) {
  const ev = S.events.find(e => e.id === evId); if (!ev) return;
  const exps = S.expenses.filter(x => x.eventId === evId);
  const text = [ev.title, ev.notes, ev.place?.name, ev.place?.address, ...exps.map(x => `${x.vendor} ${x.note}`)].join(' \n ');
  const orgs = detectOrgs(text);
  const reasons = [...new Set(S.archive.map(a => a.reason).filter(Boolean))].slice(0, 8);
  const city = cityOf(ev), date = ev.start || new Date().toISOString();
  openSheet(`<h2>🗄️ Reise archivieren</h2>
    <div class="muted small">${esc(ev.title)} · ${exps.length} Belege · ${eur(exps.reduce((s, x) => s + (+x.amount || 0), 0))}</div>
    <label class="f">Wie soll die Reise heißen?</label>
    <input class="input" id="arTitle" value="${esc([city, ev.title !== city ? ev.title : '', new Date(date).toLocaleDateString('de-DE', { month: 'short', year: 'numeric' })].filter(Boolean).join(' · '))}">
    <label class="f">Anlass / Veranstaltung (z. B. Messe, Kundentermin, Konferenz)</label>
    <input class="input" id="arReason" placeholder="optional" autocomplete="off">
    ${reasons.length ? `<div class="chips" style="margin-top:8px">${reasons.map(r => `<button class="chip" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}
    <label class="f">Organisationen (erkannt – bitte prüfen)</label>
    <input class="input" id="arOrgs" value="${esc(orgs.join(', '))}" placeholder="z. B. RWTH Aachen, Kunde GmbH">
    <label class="f">Aufbewahren</label>
    <div class="seg" id="arKeep"><button data-d="30">30 Tage</button><button data-d="180">6 Monate</button><button data-d="365">1 Jahr</button><button data-d="0" class="on">Unbegrenzt</button></div>
    <div class="small muted" style="margin-top:6px">Archivierte Reisen bleiben mindestens 30 Tage gespeichert – inklusive Belegdateien.</div>
    <button class="btn primary block" style="margin-top:14px" id="arSave">Archivieren</button>`);
  let keep = 0;
  segBind('#arKeep', b => keep = +b.dataset.d);
  $$('[data-r]').forEach(b => b.onclick = () => $('#arReason').value = b.dataset.r);
  $('#arSave').onclick = () => {
    const title = $('#arTitle').value.trim(); if (!title) { toast('Bitte einen Titel eingeben'); return; }
    const reason = $('#arReason').value.trim(), orgList = $('#arOrgs').value.split(',').map(s => s.trim()).filter(Boolean);
    const now = new Date();
    const entry = {
      id: uid(), title, reason, orgs: orgList, city, start: ev.start, archivedAt: now.toISOString(),
      keepUntil: keep ? new Date(now.getTime() + Math.max(keep, MIN_KEEP_DAYS) * 86400e3).toISOString() : null,
      event: ev, expenses: exps, total: exps.reduce((s, x) => s + (+x.amount || 0), 0), km: exps.filter(x => x.category === 'km').reduce((s, x) => s + (+x.km || 0), 0),
      terms: terms([title, reason, ev.title, ev.place?.name, city, ev.notes].join(' '))
    };
    const similar = reason && S.archive.filter(a => a.reason && sameReason(a.reason, reason));
    S.archive.push(entry);
    S.events = S.events.filter(e => e.id !== evId);
    S.expenses = S.expenses.filter(x => x.eventId !== evId);
    if (S.active?.eventId === evId) S.active = null;
    save(); closeSheet(); toast('Reise archiviert ✓');
    if (similar?.length && S.archivePrefs.reasonCriterion == null) setTimeout(() => askReasonCriterion(reason, similar), 400);
    else { planTab = 'archiv'; go('plan'); }
  };
}
function askReasonCriterion(reason, similar) {
  openSheet(`<h2>Wiederkehrender Anlass</h2>
    <p>Den Anlass <b>„${esc(reason)}“</b> gab es schon bei: ${similar.slice(0, 3).map(a => `<b>${esc(a.title)}</b>`).join(', ')}.</p>
    <p>Soll der <b>Anlass ein Sortierkriterium</b> im Archiv sein? Dann werden Reisen nach Anlass gruppiert.</p>
    <div class="row"><button class="btn primary grow" id="rcYes">Ja, nach Anlass sortieren</button><button class="btn grow" id="rcNo">Nein</button></div>
    <div class="small muted" style="margin-top:8px">Änderbar jederzeit im Archiv.</div>`);
  $('#rcYes').onclick = () => { S.archivePrefs.reasonCriterion = true; S.archivePrefs.sortBy = 'reason'; save(); closeSheet(); planTab = 'archiv'; go('plan'); };
  $('#rcNo').onclick = () => { S.archivePrefs.reasonCriterion = false; save(); closeSheet(); planTab = 'archiv'; go('plan'); };
}

/* ───────────── Aufräumen (frühestens nach 30 Tagen) ───────────── */
async function purgeArchive() {
  const now = Date.now(), keep = [], gone = [];
  for (const a of S.archive) {
    const minUntil = new Date(a.archivedAt).getTime() + MIN_KEEP_DAYS * 86400e3;
    if (a.keepUntil && new Date(a.keepUntil).getTime() < now && now > minUntil) gone.push(a); else keep.push(a);
  }
  if (!gone.length) return;
  for (const a of gone) for (const x of a.expenses || []) for (const f of x.attachments || []) await DOCS.del(f).catch(() => { });
  S.archive = keep; save();
  feed('Archiv aufgeräumt', `${gone.length} Reise(n) nach Ablauf der Aufbewahrungsfrist gelöscht: ${gone.map(a => a.title).join(', ')}`, 'info', { push: false });
}

/* ───────────── Gemeinsamkeiten clustern ───────────── */
function archiveClusters() {
  const map = new Map();
  const add = (key, label, kind, id) => { if (!key) return; const k = kind + ':' + key; if (!map.has(k)) map.set(k, { key, label, kind, ids: new Set() }); map.get(k).ids.add(id); };
  for (const a of S.archive) {
    (a.orgs || []).filter(o => !NOT_ORG.has(o.toUpperCase())).forEach(o => add(normText(o).trim(), o, 'org', a.id));
    if (a.city) add(normText(a.city).trim(), a.city, 'city', a.id);
    if (a.reason) { const twin = [...map.values()].find(c => c.kind === 'reason' && sameReason(c.label, a.reason)); add(twin ? twin.key : normText(a.reason).trim(), twin ? twin.label : a.reason, 'reason', a.id); }
    (a.terms || []).forEach(t => add(t, t.charAt(0).toUpperCase() + t.slice(1), 'term', a.id));
  }
  const cl = [...map.values()].filter(c => c.ids.size >= 2);
  // Begriffe, die schon als Organisation/Ort/Anlass auftauchen, nicht doppelt zeigen
  const covered = new Set(cl.filter(c => c.kind !== 'term').flatMap(c => terms(c.label)));
  return cl.filter(c => c.kind !== 'term' || !covered.has(c.key)).sort((a, b) => b.ids.size - a.ids.size || (a.kind === 'term') - (b.kind === 'term')).slice(0, 12);
}

/* ───────────── Archiv-Ansicht (im Tab „Plan“) ───────────── */
let planTab = 'kommend', archFilter = null;
function renderArchive() {
  const P = S.archivePrefs, cl = archiveClusters();
  let list = [...S.archive];
  if (archFilter) { const c = cl.find(c => c.kind + ':' + c.key === archFilter); if (c) list = list.filter(a => c.ids.has(a.id)); else archFilter = null; }
  const sorts = [['date', 'Datum'], ['city', 'Ort'], ['org', 'Organisation'], ...(P.reasonCriterion ? [['reason', 'Anlass']] : [])];
  if (!sorts.some(s => s[0] === P.sortBy)) P.sortBy = 'date';
  const keyOf = a => P.sortBy === 'city' ? (a.city || 'Ohne Ort') : P.sortBy === 'org' ? (a.orgs?.[0] || 'Ohne Organisation') : P.sortBy === 'reason' ? (S.archive.find(b => b.reason && a.reason && sameReason(b.reason, a.reason))?.reason || 'Ohne Anlass') : new Date(a.start || a.archivedAt).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  list.sort((a, b) => P.sortBy === 'date' ? new Date(b.start || b.archivedAt) - new Date(a.start || a.archivedAt) : keyOf(a).localeCompare(keyOf(b), 'de') || new Date(b.start || b.archivedAt) - new Date(a.start || a.archivedAt));
  let h = `<div class="row wrap" style="margin:6px 0 4px"><span class="small muted">Sortieren:</span><div class="chips">${sorts.map(([k, l]) => `<button class="chip ${P.sortBy === k ? 'on' : ''}" onclick="S.archivePrefs.sortBy='${k}';save();renderPlan()">${l}</button>`).join('')}</div></div>`;
  if (P.reasonCriterion === false && S.archive.some(a => a.reason)) h += `<button class="btn ghost sm" onclick="S.archivePrefs.reasonCriterion=true;save();renderPlan()">＋ Anlass als Sortierkriterium</button>`;
  if (cl.length) h += `<div class="card flat"><div class="eyebrow">Gemeinsamkeiten</div><div class="chips" style="margin-top:8px">${cl.map(c => `<button class="chip ${archFilter === c.kind + ':' + c.key ? 'on' : ''}" onclick="archFilter=archFilter==='${c.kind}:${esc(c.key)}'?null:'${c.kind}:${esc(c.key)}';renderPlan()">${{ org: '🏢', city: '📍', reason: '🎯', term: '🏷️' }[c.kind]} ${esc(c.label)} <b>${c.ids.size}</b></button>`).join('')}</div></div>`;
  if (!list.length) h += `<div class="empty"><div class="ico">🗄️</div>Noch keine archivierten Reisen. Nach der Ankunft oder über einen Termin → „Archivieren“.</div>`;
  let last = null;
  for (const a of list) {
    const k = keyOf(a); if (k !== last) { h += `<div class="daylabel">${esc(k)}</div>`; last = k; }
    const days = a.keepUntil ? Math.ceil((new Date(a.keepUntil) - Date.now()) / 86400e3) : null;
    h += `<div class="item" onclick="openArchived('${a.id}')"><div class="ic">${KIND[a.event?.kind]?.ico || '🧳'}</div><div class="grow"><b class="ellipsis" style="display:block">${esc(a.title)}</b><div class="small muted ellipsis">${a.start ? fmtD(a.start) + ' · ' : ''}${esc(a.reason || '')}${a.orgs?.length ? ' · ' + esc(a.orgs.slice(0, 2).join(', ')) : ''}</div></div><div class="when">${eur(a.total)}<div class="small muted">${days != null ? `noch ${days} T.` : '∞'}</div></div></div>`;
  }
  return h;
}
function openArchived(id) {
  const a = S.archive.find(x => x.id === id); if (!a) return;
  const age = (Date.now() - new Date(a.archivedAt)) / 86400e3;
  openSheet(`<h2>🗄️ ${esc(a.title)}</h2>
    <div class="muted small">${a.start ? fmtD(a.start) + ' · ' : ''}${esc(a.event?.place?.name || '')}${a.city ? ', ' + esc(a.city) : ''}</div>
    ${a.reason ? `<div style="margin-top:6px">🎯 ${esc(a.reason)}</div>` : ''}${a.orgs?.length ? `<div>🏢 ${esc(a.orgs.join(', '))}</div>` : ''}
    <div class="small muted" style="margin-top:6px">Archiviert am ${new Date(a.archivedAt).toLocaleDateString('de-DE')} · ${a.keepUntil ? 'aufbewahrt bis ' + new Date(a.keepUntil).toLocaleDateString('de-DE') : 'unbegrenzt aufbewahrt'}</div>
    <div class="card flat"><div class="spread"><b>Kosten</b><b>${eur(a.total)}</b></div>${(a.expenses || []).map(x => `<div class="spread small" style="margin-top:4px"><span>${CAT[x.category]?.ico || ''} ${esc(x.vendor || CAT[x.category]?.label)}${x.attachments?.length ? ' 📎' : ''}</span><span>${eur(x.amount)}</span></div>`).join('') || '<div class="small muted">keine Belege</div>'}${a.km ? `<div class="small muted" style="margin-top:6px">${String(a.km).replace('.', ',')} km mit dem Auto</div>` : ''}</div>
    <div class="list">
      <button class="btn block" onclick="editArchived('${a.id}')">✏️ Titel / Anlass / Organisationen ändern</button>
      <button class="btn block" onclick="archiveCsv('${a.id}')">📤 Kosten als CSV</button>
      <button class="btn block" onclick="restoreArchived('${a.id}')">↩︎ Wiederherstellen</button>
      <button class="btn danger block" onclick="deleteArchived('${a.id}')">Löschen${age < MIN_KEEP_DAYS ? ` (Frist: noch ${Math.ceil(MIN_KEEP_DAYS - age)} Tage)` : ''}</button>
    </div>`);
}
function editArchived(id) {
  const a = S.archive.find(x => x.id === id);
  openSheet(`<h2>Archiv-Eintrag bearbeiten</h2>
    <label class="f">Titel</label><input class="input" id="eaT" value="${esc(a.title)}">
    <label class="f">Anlass</label><input class="input" id="eaR" value="${esc(a.reason || '')}">
    <label class="f">Organisationen</label><input class="input" id="eaO" value="${esc((a.orgs || []).join(', '))}">
    <button class="btn primary block" style="margin-top:14px" id="eaS">Speichern</button>`);
  $('#eaS').onclick = () => {
    const newReason = $('#eaR').value.trim();
    const similar = newReason && newReason !== a.reason && S.archive.filter(b => b.id !== a.id && b.reason && sameReason(b.reason, newReason));
    Object.assign(a, { title: $('#eaT').value.trim() || a.title, reason: newReason, orgs: $('#eaO').value.split(',').map(s => s.trim()).filter(Boolean) });
    a.terms = terms([a.title, a.reason, a.event?.title, a.event?.place?.name, a.city, a.event?.notes].join(' '));
    save(); closeSheet(); renderPlan();
    if (similar?.length && S.archivePrefs.reasonCriterion == null) setTimeout(() => askReasonCriterion(newReason, similar), 300);
  };
}
function restoreArchived(id) {
  const a = S.archive.find(x => x.id === id); if (!a) return;
  S.events.push({ ...a.event, done: true }); S.expenses.push(...(a.expenses || []));
  S.archive = S.archive.filter(x => x.id !== id); save(); closeSheet(); planTab = 'kommend'; renderPlan(); toast('Wiederhergestellt');
}
async function deleteArchived(id) {
  const a = S.archive.find(x => x.id === id); if (!a) return;
  const age = (Date.now() - new Date(a.archivedAt)) / 86400e3;
  if (!confirm(age < MIN_KEEP_DAYS ? `„${a.title}“ ist erst ${Math.floor(age)} Tage im Archiv (Mindestaufbewahrung 30 Tage). Trotzdem endgültig löschen – inkl. Belegdateien?` : `„${a.title}“ endgültig löschen – inkl. Belegdateien? Das kann nicht rückgängig gemacht werden.`)) return;
  for (const x of a.expenses || []) for (const f of x.attachments || []) await DOCS.del(f).catch(() => { });
  S.archive = S.archive.filter(x => x.id !== id); save(); closeSheet(); renderPlan();
}
function archiveCsv(id) {
  const a = S.archive.find(x => x.id === id);
  const rows = [['Reise', 'Anlass', 'Datum', 'Kategorie', 'Anbieter', 'Beschreibung', 'Kilometer', 'Betrag', 'MwSt']];
  (a.expenses || []).forEach(x => rows.push([a.title, a.reason || '', x.date, CAT[x.category]?.label, x.vendor, x.note, x.km ?? '', (+x.amount).toFixed(2).replace('.', ','), (+x.vat || 0).toFixed(2).replace('.', ',')]));
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  shareOrDownload(new File([csv], `${a.title.replace(/[^\wäöüß-]+/gi, '_')}.csv`, { type: 'text/csv' }));
}
