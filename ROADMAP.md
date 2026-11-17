# Reisebegleiter – Roadmap

## Stufe 1 (erledigt, Web-App/PWA)
- Termine/Ziele: Schnell-Eingabe, E-Mail-Text, .ics, Screenshot (OCR / Claude)
- Live-Begleitung: Echtzeit-Abgleich (Transitous/MOTIS), „Ich sitze im Zug“, bester Ausstieg, Neu planen
- Letzte Meile: ÖPNV, zu Fuß, Rad, Uber/Taxi (Deep-Link + Preisschätzung), Auto (HERE optional)
- Relevanzfilter: Push nur bei Auswirkung auf dich (neue Ankunft, gerissener Anschluss + fertige Alternative,
  Gleiswechsel/Verspätung des Zuges, auf den du wartest, Aus-/Umstieg). Verspätungen hinfälliger Fahrten → still.
- Reisekosten: Belege per Foto/PDF (Betrag, MwSt, Datum, Anbieter automatisch), Kilometer (GPS / Tacho / Route),
  Verpflegungspauschale, Bericht (HTML→PDF mit Belegen) und CSV
- Live-Leiste + Assistenz-Bubble in der App, GPS-Reiseprotokoll, lernende Feedback-Schleife

## Stufe 1b (erledigt)
- Letzte Meile begleiten: zu Fuß per GPS (eigene Abbiegehinweise + Straßennamen) oder Übergabe an Google Maps/Apple Karten
- ÖPNV-Begleitung: Fußweg zum richtigen Steig → Fahrt → Ausstiegs-Hinweis → Fußweg zum Ziel
- Haltestellen-Finder: gleichnamige Steige (z. B. Aachen Normaluhr H.2–H.6, Bushof H.1–H.15), Lage, Straße,
  Linien je Steig, Warnung „falsche Haltestelle“, Karte; OSM ergänzt Wartehäuschen & Orientierungspunkte
- Eingriffsregeln: aktiv nur bei gravierender Störung (≥ 20 Min, Ausfall, gerissener Anschluss, Störung auf der
  Reststrecke) und nur, wenn die Alternative belastbar besser ist (≥ 10 Min früher, Umstiege als Risiko gewertet);
  vorletzter/vorvorletzter Halt wird als früherer Ausstieg geprüft
- Archiv: Titel, Anlass, Organisationen; Aufbewahrung mind. 30 Tage; Gemeinsamkeiten-Cluster; Anlass als Sortierkriterium auf Nachfrage

## Stufe 1c (erledigt)
- Termine vorab: Einladung/Tagesordnung als PDF, Foto, .ics oder Text hochladen → Titel, Datum, Beginn/Ende, Ort, Raum, Kontakt
- Anreise vorab planen: Start (Standort / Zuhause / zuletzt genutzt / beliebig), „Ankommen bis“ oder „Losfahren um“,
  Verbindung antippen – jederzeit „Ändern“/„Entfernen“
- Am Reisetag: geplante Fahrten alle 10 Min live geprüft (Ausfall / ≥ 20 Min → Hinweis „Neu planen“),
  Losgeh-Erinnerung, „Geplante Anreise nutzen“ beim Start; ist sie schon weg → nächste sichere Verbindung

## Stufe 1d (erledigt)
- „In welchem Zug sitzt du?“ neu: automatische Erkennung per GPS (Echtzeit-Positionen aller Züge im Umkreis von
  ~18 km, verglichen mit Standort, Richtung, Tempo) oder Einstieg + Fahrkarte-bis → nur Züge, die beide Halte
  bedienen und gerade fahren. Erst 3 Vorschläge, „Weitere Optionen“, zuletzt Abfahrtsliste/Zugnummer.
  Der Halt „Fahrkarte bis“ wird zum geplanten Ausstieg.

## Stufe 2 (vorgemerkt – braucht native App bzw. Server)
- [ ] **Live-Aktivität auf dem Sperrbildschirm & Dynamic Island** (ActivityKit) – Assistenz dauerhaft in der Leiste oben
- [ ] **Push bei gesperrtem iPhone**: kleiner Server überwacht die Reise und schickt Web-Push/APNs
      (Relevanzregeln aus `evaluate()` serverseitig wiederverwenden)
- [ ] **Hintergrund-GPS** für Kilometer & Reiseprotokoll bei geschlossener App (CoreLocation „significant changes“)
- [ ] Teilen-Erweiterung: Mail/PDF/Foto direkt „an Reisebegleiter senden“
- [ ] Siri-Kurzbefehle („Wann komme ich an?“), Apple-Wallet-Tickets einlesen
- [ ] Kalenderzugriff direkt (EventKit) statt .ics-Import
- [ ] Sync zwischen Geräten / Export an Reisekosten-Systeme (z. B. DATEV, SAP Concur)

Umsetzungsweg: SwiftUI-App (Mac + Xcode nötig) oder Expo/React Native mit nativen Modulen; die Logik aus
`app.js`/`costs.js` kann übernommen werden.
