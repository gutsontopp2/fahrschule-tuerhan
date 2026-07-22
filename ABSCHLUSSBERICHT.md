# Abschlussbericht – Fahrschule Türhan: Website & Buchungssystem

Stand: 22.07.2026 · Branch: `feature/website-fertigstellung`
(Ausgangszustand gesichert im Commit «Sicherung: Ausgangszustand des Themes»)

---

## 1. Zusammenfassung

- Das bestehende Custom-Theme wurde inhaltlich fertiggestellt: Startseite mit
  Hero, Vertrauensleiste, Vorteilen, Angebot, «Über Dilek Türhan»,
  «Weg zum Führerschein», Bewertungen, FAQ, Kontakt und Buchungs-CTA.
- Neu implementiert wurde ein vollständiges, serverseitiges **Buchungs-Backend**
  (`booking-app/`, TypeScript + PostgreSQL) mit App Proxy, Webhooks,
  Admin-Oberfläche und automatisierten Tests. Doppelbuchungen werden auf
  **Datenbankebene** (Exclusion-Constraint) verhindert.
- Der Theme-Kalender wurde auf den Shopify App Proxy (`/apps/booking`)
  umgestellt; das Buchungsformular erfasst Vorname/Nachname, Getriebeart,
  Treffpunkt, «erste Fahrstunde» und die Bestätigung der Bedingungen.
- Erfundene Inhalte wurden entfernt (Bewertungen «Lea»/«Jonas»,
  «inkl. MwSt.», «per Karte oder TWINT»); Betreiber-Hinweise sind nur noch
  im Theme-Editor sichtbar. Veraltete Wix-Inhalte («Neue Regelungen ab 2021»,
  COVID-Hinweise, Hygienemaske, tote Links) wurden nicht übernommen; der
  «Weg zum Führerschein» trennt Liechtenstein und Schweiz, verlinkt offizielle
  Stellen und zeigt «Zuletzt geprüft am» mit Behörden-Hinweis.

**Wichtig / ehrlich:** Nichts davon ist live. Deployment, App-Installation,
App-Proxy-Einrichtung, Webhook-Registrierung, Datenbank-Migration, Produkte,
Preise, Navigation und Seiten müssen im Shopify-Admin bzw. beim Hoster noch
eingerichtet werden (Abschnitte 7–9). Die DB-Integrationstests laufen erst
mit einer PostgreSQL-Instanz (`TEST_DATABASE_URL`), lokal war keine verfügbar –
die 19 Logik-Tests (Slots, Puffer, DST) laufen und bestehen lokal.

## 2. Geänderte Dateien (Theme)

| Datei | Änderung |
|---|---|
| `assets/booking.js` | Komplett überarbeitet: App Proxy statt direkter Backend-URL, Leistungen vom Backend, Getriebe-Auswahl, Vorname/Nachname, Bedingungen-Checkbox, Honeypot, Idempotency-Key, signierter Buchungstoken im Warenkorb, Entfernen alter Buchungs-Positionen inkl. Hold-Freigabe, Fehlertexte |
| `assets/global.js` | Warenkorb: «Termin entfernen» gibt die serverseitige Reservierung frei |
| `assets/base.css` | Neue Styles: Vertrauensleiste, «Weg zum Führerschein», Checkbox-Felder |
| `sections/booking.liquid` | Neue Formularfelder, App-Proxy-Konfiguration, Bedingungen-/Datenschutz-Links, Betreiber-Hinweise nur im Theme-Editor (`request.design_mode`), Offline-Fallback mit Telefon/WhatsApp, Hold-Anzeige 20 Min. |
| `sections/hero.liquid` | Sekundär-Buttons «WhatsApp schreiben» und «Jetzt anrufen» |
| `sections/packages.liquid` | Interner Hinweis nur im Editor; Kundentext ohne unbelegte Zahlungsversprechen |
| `sections/testimonials.liquid` | Editor-Hinweis «nur echte Bewertungen», erfundene Preset-Bewertungen entfernt |
| `sections/main-cart.liquid` | Entfernen-Link mit Hold-Daten für die Freigabe |
| `snippets/meta-tags.liquid` | og:locale, Logo als OG-Fallback, vollständigere DrivingSchool-Strukturdaten (Adresse, sameAs) |
| `snippets/product-card.liquid` | «inkl. MwSt.» entfernt (nicht belegt) |
| `config/settings_schema.json` | Buchungs-Einstellungen bereinigt (Backend-URL/Fahrlehrer-Auswahl entfernt, Hinweis auf App Proxy) |
| `config/settings_data.json` | Entfernte Einstellung bereinigt |
| `templates/index.json` | Neue Reihenfolge gemäss Vorgabe, Vertrauensleiste, 4 Vorteile, Ablauf-Sektion, nur bestätigte Bewertung (Fabio, von der alten Website) |
| `templates/page.buchung.json` | Reservierungsdauer-FAQ auf 20 Minuten |

## 3. Neu erstellte Dateien

**Theme**

- `sections/trust-bar.liquid` – Vertrauensleiste (50 Min / Handschaltung & Automat / FL & Werdenberg / Online-Buchung)
- `sections/steps.liquid` – «Weg zum Führerschein» mit offiziellen Links, «Zuletzt geprüft am» und Behörden-Hinweis
- `templates/page.ueber-mich.json` – Seite «Über mich»
- `templates/page.weg-zum-fuehrerschein.json` – Seite «Weg zum Führerschein» (FL/CH getrennt)

**Buchungs-Backend (`booking-app/`)**

- `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `shopify.app.toml`, `README.md`
- `migrations/001_init.sql` – Schema inkl. `bookings_no_overlap`-Constraint
- `src/` – `index.ts`, `config.ts`, `db.ts`, `availability.ts` (Slot-Logik),
  `bookingService.ts` (Holds/Bestätigen/Stornieren/Verschieben),
  `shopify.ts` (Proxy-/Webhook-HMAC, signierte Tokens), `adminAuth.ts`,
  `rateLimit.ts`, `notify.ts`, `ics.ts`, `migrate.ts`,
  `routes/proxy.ts`, `routes/webhooks.ts`, `routes/admin.ts`
- `public/admin/index.html` – geschützte Admin-UI (Kalender Tag/Woche/Monat,
  Buchungen, Suche, CSV-Export, Arbeitszeiten, Urlaub/Sperren, manuelle
  Startzeiten, Leistungen, Einstellungen, Status-Farben)
- `test/availability.test.ts`, `test/integration.test.ts`

**Dokumentation**

- `docs/rechtstexte/impressum.md`, `datenschutz.md`, `agb.md`,
  `buchungsbedingungen.md` – Entwürfe mit klaren `[PLATZHALTERN]`
- `docs/shopify-email-buchungsdetails.liquid` – Snippet für die
  Shopify-Bestellbestätigung (Buchungsdetails sichtbar)
- `ABSCHLUSSBERICHT.md` (diese Datei)

## 4. Architektur des Buchungssystems

```
Kunde ──> Theme-Kalender (booking.js)
             │  GET  /apps/booking/services | /availability      (App Proxy,
             │  POST /apps/booking/holds  … DELETE /holds/:id     von Shopify signiert)
             ▼
        Backend (Express/TS)  ── PostgreSQL (EXCLUDE-Constraint gegen Überlappung)
             ▲
Shopify ─────┘ Webhooks: orders/paid, orders/cancelled, refunds/create,
               customers/data_request, customers/redact, shop/redact
```

- **Hold:** `POST /holds` prüft serverseitig (nie Browser-Daten vertrauen)
  Leistung, Arbeitszeiten, Ausnahmen, Vorlauf/Vorausbuchung und legt die
  Reservierung atomar an (Status `held`, 20 Min., verlängerbar). Bei
  Kollision: 409 «Dieser Termin wurde gerade vergeben…».
- **Checkout:** Produkt (Menge fix 1) mit sichtbaren Properties Termin,
  Uhrzeit, Fahrstundenart, Dauer, Treffpunkt, Getriebe + privatem, HMAC-
  signiertem `_booking_token`. Mehrfach-Buchungen im Warenkorb werden
  automatisch ersetzt; «Termin entfernen» gibt den Hold frei.
- **Bestätigung:** `orders/paid` (HMAC + Event-ID idempotent) setzt
  `held → confirmed`, speichert Bestellnummer, sendet Kunden-/Betreiber-Mail
  (SMTP optional) inkl. Verwaltungslink und `.ics`. War der Hold abgelaufen
  und der Slot inzwischen vergeben → `needs_review` + Betreiber-Hinweis.
- **Statuswerte:** `held`, `confirmed`, `blocked`, `cancelled`, `expired`,
  `needs_review` (verfügbar = kein Eintrag).
- **Stornieren/Verschieben:** über zufälligen `manage_token`; Verschieben
  ändert die Zeiten in einer Transaktion (kein Zwischenzustand); kurzfristige
  Stornierung → `needs_review` ohne automatische Rückerstattung.

## 5. Datenbankschema (Kurzform)

- `services` (shopify_product_id, shopify_variant_id, name, duration_minutes,
  buffer_minutes NULL=global, vehicle_type, active)
- `availability_rules` (weekday 1–7, start_time, end_time, active, timezone) –
  mehrere Fenster pro Tag = Pausen
- `availability_exceptions` (date, start_time?, end_time?, type:
  available|blocked|holiday|vacation, reason)
- `manual_slots` (start_at, service_id?, note) – manuell freigegebene Startzeiten
- `bookings` (…, start_at, lesson_end_at, blocked_until, timezone, status,
  hold_expires_at, manage_token, shopify_cart_token, shopify_order_id,
  shopify_order_number, idempotency_key, …) mit
  `EXCLUDE USING gist (tstzrange(start_at, blocked_until) WITH &&)
   WHERE (status IN ('held','confirmed','blocked'))`
- `webhook_events` (provider_event_id UNIQUE, topic, processed_at, payload_hash)
- `settings` (buffer_minutes 10–20, hold_minutes, min_lead_minutes,
  max_advance_days, cancel_window_hours, timezone)

## 6. Umgebungsvariablen (`booking-app/.env.example`)

`PORT`, `DATABASE_URL`, `SHOPIFY_API_SECRET`, `SHOPIFY_SHOP_DOMAIN`,
`APP_SECRET`, `ADMIN_PASSWORD_HASH`, `PUBLIC_SHOP_URL`,
`SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`, `MAIL_OPERATOR`, `NODE_ENV`
(Entwicklung zusätzlich: `ALLOW_UNSIGNED_PROXY=1`).

## 7. Erforderliche Shopify-Admin-Schritte

1. **Custom App** anlegen (Scope `read_products`), **App Proxy**: Prefix
   `apps`, Subpath `booking`, URL `https://<BACKEND>/proxy`.
2. **Webhooks** registrieren (orders/paid, orders/cancelled, refunds/create →
   Backend-URLs; Details in `booking-app/README.md`, dort auch der Hinweis
   zum Signatur-Secret).
3. **Produkte** anlegen: «Fahrstunde Handschaltung, 50 Minuten»,
   «Fahrstunde Automat, 50 Minuten», optional Doppellektion/Pakete/Gutschein –
   **Preise trägt die Betreiberin ein (keine Preise erfunden)** – und einer
   Kollektion **«Fahrstunden»** zuordnen.
4. **Seiten** anlegen und Vorlage zuweisen: Buchung (`page.buchung`),
   Buchung bestätigt (`page.bestaetigung`), Häufige Fragen (`page.faq`),
   Kontakt (`page.kontakt`), Über mich (`page.ueber-mich`),
   Weg zum Führerschein (`page.weg-zum-fuehrerschein`) sowie Impressum,
   Datenschutzerklärung, AGB, Buchungs- und Stornierungsbedingungen
   (Standard-Vorlage; Texte aus `docs/rechtstexte/` nach Prüfung einfügen).
5. **Navigation**: Hauptmenü = Startseite, Fahrstunden (Kollektion),
   Fahrstunde buchen, Über mich, Weg zum Führerschein, Häufige Fragen,
   Kontakt. Footer-Menü «Rechtliches» = Impressum, Datenschutzerklärung,
   AGB, Buchungs- und Stornierungsbedingungen. Den alten Eintrag «Katalog»
   entfernen.
6. **Theme-Einstellungen**: Buchungsseite zuweisen, Treffpunkte prüfen,
   echtes Logo/Fotos (Fahrlehrerin, weisser Seat Leon FR) hochladen – im
   Repo liegen keine Bilddateien, daher konnten keine echten Bilder
   eingebunden werden.
7. **Homepage-Titel/Meta** (Onlineshop → Einstellungen): z. B.
   «Fahrschule Türhan | Fahrstunden in Liechtenstein & Werdenberg» –
   bleibt frei anpassbar.
8. **Bestellbestätigungs-E-Mail**: Snippet aus
   `docs/shopify-email-buchungsdetails.liquid` einfügen.
9. **Spam-Schutz** für Formulare aktivieren (Onlineshop → Einstellungen →
   hCaptcha), Zahlungsanbieter einrichten und Checkout auf Deutsch prüfen.
10. Nach dem Anlegen der Produkte im **Backend-Admin** die Leistungen
    verknüpfen (Produkt-/Varianten-ID, Dauer, Puffer, Getriebe) und
    Arbeitszeiten/Urlaub/Einstellungen pflegen.

## 8. Deployment (Backend)

Siehe `booking-app/README.md`: `.env` ausfüllen → `npm install` →
`npm run migrate` → Admin-Passwort-Hash erzeugen → `npm run build && npm start`
hinter HTTPS (Railway/Render/Fly.io o. ä.). Health-Check: `GET /healthz`.

## 9. Buchungssystem testen

**Automatisiert** (in `booking-app/`):

- `npm test` – 19 Logik-Tests: Slot-Raster 50+20, 12:00 blockiert bis 13:10,
  13:00 abgelehnt / 13:10 angeboten, Teilüberlappungen, Urlaub/geschlossene
  Tage/Sperren, manuelle Startzeiten, Vorlauf/Vorausbuchung, Sommer-/
  Winterzeit (inkl. nicht existierender 02:30-Zeit). **Lokal ausgeführt: bestanden.**
- `TEST_DATABASE_URL=postgres://… npm test` – 14 Integrationstests:
  parallele Doppelbuchung (genau einer gewinnt), Hold-Ablauf und -Wiederfreigabe,
  Idempotenz (Holds + Webhooks), Bestätigung durch bezahlte Bestellung,
  Stornierung (fristgerecht und kurzfristig → `needs_review`), atomare
  Verschiebung, manipulierte Daten. **Noch nicht ausgeführt – lokal war kein
  PostgreSQL/Docker verfügbar. Vor dem Livegang gegen eine Test-DB laufen lassen.**

**Manueller End-to-End-Test** (nach Einrichtung, im Shopify-Testmodus):

1. Buchungsseite öffnen → Fahrstundenart, Datum, Uhrzeit wählen.
2. Kundendaten eingeben, Bedingungen bestätigen → «Verbindlich buchen».
3. Warenkorb prüfen (Termin/Uhrzeit/Treffpunkt sichtbar, Menge fix 1).
4. Testzahlung (Shopify Bogus Gateway) durchführen.
5. Bestätigungsseite/-mail prüfen; Backend-Admin: Status «Bestätigt».
6. Parallel in einem zweiten Browser denselben Slot versuchen →
   Meldung «Dieser Termin wurde gerade vergeben…».
7. Termin aus dem Warenkorb entfernen (ohne Zahlung) → Slot wird wieder frei.
8. Verwaltungslink aus der Mail: verschieben/stornieren testen.
9. Mobile Ansicht (Smartphone) für Startseite, Buchung, Warenkorb prüfen.

## 10. Bekannte Einschränkungen

- Kein Live-Deployment; Webhooks/App Proxy erst nach Einrichtung aktiv.
- DB-Integrationstests benötigen eine PostgreSQL-Instanz (siehe oben).
- Rate Limiting ist in-memory (für eine Instanz ausgelegt).
- E-Mail-Versand nur bei konfiguriertem SMTP; sonst kommt die
  Kundenbestätigung ausschliesslich von Shopify.
- Erinnerungs-E-Mail «24 h vorher» (in der Bestätigungsseite erwähnt) ist
  nicht implementiert – Text ggf. anpassen oder einen Cron-Job ergänzen.
- Die Kundenseite zur Buchungsverwaltung ist als API + Mail-Link umgesetzt
  (`/apps/booking/bookings/:token`); eine hübsche HTML-Seite im Theme dafür
  kann bei Bedarf ergänzt werden.
- Statistiken («61+», «99 %», Bewertung von Fabio) stammen von der alten
  Website – bitte bestätigen, sonst entfernen.
- Rechtstexte sind Entwürfe mit Platzhaltern und **müssen fachlich/rechtlich
  geprüft** werden.

## 11. Noch benötigte Angaben / Zugänge

- Shopify-Adminzugang (App, Produkte, Seiten, Menüs, Webhooks, E-Mail-Template)
- Hosting- und PostgreSQL-Zugang für das Backend
- **Preise** der Fahrstunden/Pakete (bewusst nicht erfunden)
- Echte Fotos (Dilek Türhan, weisser Seat Leon FR) mit Nutzungserlaubnis
- Bestätigung: Firmendaten (Registernummer), Stornofrist, Öffnungszeiten,
  Treffpunkte, Instagram-URL
- Optional: SMTP-Zugangsdaten für Termin-/Betreiber-Mails
