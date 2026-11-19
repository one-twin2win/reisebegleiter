/* Reisebegleiter – Folgeetappen („Teilstrecken“) innerhalb einer Reise
 * Neuer Termin in der Nähe (≤ 50 km) einer laufenden/vorherigen Etappe (z. B. Hotel in Berlin) → wird als nächste
 * Etappe verknüpft; Start der Anfahrt = diese Etappe (z. B. das Hotel), Ankunft spätestens = Termin.
 */
'use strict';

function findAnchor(ev) {
  if (!ev.place?.lat) return null;
  const t = ev.start ? new Date(ev.start).getTime() : Date.now();
  if (window._nextAfter) { const a = S.events.find(e => e.id === window._nextAfter); window._nextAfter = null; if (a) return a; }
  const cands = S.events.filter(e => e.id !== ev.id && e.place?.lat && haversine(e.place, ev.place) < 50000).filter(e =>
    S.active?.eventId === e.id ||
    (e.start ? new Date(e.start).getTime() <= t && t - new Date(e.start).getTime() < 5 * 86400e3 : e.kind === 'hotel'));
  // Übernachtung (Hotel) bevorzugt – von dort startet man morgens –, sonst die jüngste Etappe davor
  cands.sort((a, b) => (b.kind === 'hotel') - (a.kind === 'hotel') || new Date(b.start || 0) - new Date(a.start || 0));
  return cands[0] || null;
}
function linkFollowUp(ev) {
  const a = findAnchor(ev); if (!a) return null;
  ev.after = a.id; ev.trip = a.trip || a.id; a.trip = ev.trip; save();
  return a;
}
function offerFollowUp(ev) {
  const a = linkFollowUp(ev); if (!a) return false;
  const by = ev.arriveBy || ev.start;
  openSheet(`<h2>🧳 Gehört zu deiner Reise</h2>
    <p>„${esc(ev.title)}“ liegt ${fmtKm(haversine(a.place, ev.place))} von <b>${esc(a.title)}</b> entfernt. Ich habe es als nächste Etappe eingeplant.</p>
    ${by ? `<p>Soll ich die Anfahrt <b>ab ${esc(a.place.name || a.title)}</b> planen – Ankunft spätestens <b>${fmtD(by)}, ${fmtT(by)}</b>?</p>` : ''}
    <div class="list"><button class="btn primary block" onclick="prePlanFrom('${ev.id}')">Ja, Anfahrt planen</button>
    <button class="btn block" onclick="closeSheet();openPrePlan('${ev.id}')">Anderen Start wählen</button>
    <button class="btn ghost block" onclick="closeSheet()">Später</button></div>`);
  return true;
}
function prePlanFrom(evId) {
  const ev = S.events.find(e => e.id === evId), a = S.events.find(e => e.id === ev?.after); if (!ev || !a) return;
  closeSheet();
  const by = ev.arriveBy || ev.start;
  openPrePlan(ev.id, { origin: { ...a.place, name: a.place.name || a.title }, mode: by ? 'arr' : 'dep', time: by || null, exact: !!ev.arriveBy });
  setTimeout(() => $('#ppGo')?.click(), 250); // gleich Verbindungen zeigen
}
/* Danach-Zeile während der Fahrt: nächste Etappe der Reise */
function nextStageLine(ev) {
  const n = S.events.filter(e => e.after === ev.id && !e.done && (!e.start || new Date(e.start).getTime() > Date.now() - 3600e3)).sort((a, b) => new Date(a.start || 0) - new Date(b.start || 0))[0];
  if (!n) return '';
  const by = n.arriveBy || n.start;
  return `<button class="wp" onclick="openEvent('${n.id}')"><span class="wp-ico">➡️</span><span class="grow"><b>Danach: ${esc(n.title)}</b><span class="wp-sub" style="display:block">${by ? `${fmtD(by)}, spätestens ${fmtT(by)}` : ''}${n.plan ? ' · ' + prePlanLine(n).replace(/^🧭 /, '') : ' · Anfahrt noch nicht geplant'}</span></span><span class="wp-chev">›</span></button>`;
}
