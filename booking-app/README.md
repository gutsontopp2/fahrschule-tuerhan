# Fahrschule Türhan – Buchungs-Backend (Shopify Custom App)

Serverseitiges Buchungssystem für die Online-Terminbuchung von Fahrstunden.
Verhindert Doppelbuchungen auf **Datenbankebene** (PostgreSQL-Exclusion-
Constraint), verwaltet Verfügbarkeiten, Holds, Stornierungen und bestätigt
Buchungen über Shopify-Webhooks.

## Architektur

```
Shopify Storefront (Theme)
   │  /apps/booking/*  (App Proxy, von Shopify signiert)
   ▼
Backend (Node/TypeScript, Express)          Shopify-Admin
   │  /proxy/*      Storefront-API             │ Webhooks (orders/paid, …)
   │  /webhooks/*   HMAC-verifiziert  ◄────────┘
   │  /admin        geschützte Verwaltungs-UI
   ▼
PostgreSQL  (bookings mit EXCLUDE-Constraint gegen Überlappungen)
```

Buchungsablauf:

1. Theme lädt Leistungen + Verfügbarkeit über den App Proxy.
2. «Verbindlich buchen» → `POST /proxy/holds` legt **atomar** eine
   Reservierung an (Status `held`, Standard 20 Minuten). Zwei parallele
   Anfragen auf denselben oder einen überlappenden Zeitraum: genau eine
   gewinnt, die zweite erhält 409 `SLOT_TAKEN`.
3. Theme legt das Produkt mit Line-Item-Properties in den Warenkorb
   (u. a. signierter `_booking_token`) und leitet zum Shopify-Checkout.
4. Webhook `orders/paid` verifiziert HMAC + Buchungstoken und setzt die
   Buchung auf `confirmed` (idempotent über die Webhook-Event-ID).
5. Abgelaufene Holds werden automatisch freigegeben (`expired`).

Zeitregeln: 50 Min. Unterricht + konfigurierbarer Puffer (10–20 Min.,
Standard 20). Eine Buchung 12:00–12:50 blockiert 12:00–13:10; der nächste
angebotene Termin ist 13:10. Zeitzone Europe/Zurich inkl. Sommer-/Winterzeit
(Luxon). Alle Zeiten werden als UTC (`timestamptz`) gespeichert.

## Einrichtung

### 1. Voraussetzungen

- Node.js ≥ 20, PostgreSQL ≥ 14 (z. B. Neon, Supabase, Railway)
- Ein Hosting mit öffentlicher HTTPS-URL (z. B. Railway, Render, Fly.io)

### 2. Shopify Custom App anlegen

Shopify-Admin → Einstellungen → Apps und Vertriebskanäle → Apps entwickeln →
App erstellen («Fahrschule Türhan Buchung»).

- **API-Zugriffsbereiche:** `read_products` (mehr wird nicht benötigt)
- **App Proxy** (unter App-Konfiguration): Prefix `apps`, Subpath `booking`,
  Proxy-URL `https://<BACKEND-DOMAIN>/proxy`
- Das **API-Secret** der App → `SHOPIFY_API_SECRET`

### 3. Backend konfigurieren und starten

```bash
cd booking-app
cp .env.example .env       # Werte ausfüllen
npm install
npm run migrate            # Datenbank-Schema anlegen
echo "MeinAdminPasswort" | npm run migrate -- --hash-password
                           # Ausgabe als ADMIN_PASSWORD_HASH in .env übernehmen
npm run build && npm start # Produktion  (Entwicklung: npm run dev)
```

### 4. Webhooks registrieren

Shopify-Admin → Einstellungen → Benachrichtigungen → Webhooks (Format JSON):

| Ereignis | URL |
|---|---|
| Bestellung bezahlt (`orders/paid`) | `https://<BACKEND-DOMAIN>/webhooks/orders-paid` |
| Bestellung storniert (`orders/cancelled`) | `https://<BACKEND-DOMAIN>/webhooks/orders-cancelled` |
| Rückerstattung erstellt (`refunds/create`) | `https://<BACKEND-DOMAIN>/webhooks/refunds-create` |

Wichtig: Webhooks, die im Admin unter «Benachrichtigungen» angelegt werden,
signieren mit dem dort angezeigten Secret. Werden die Webhooks stattdessen
über die Admin-API der Custom App registriert, signiert Shopify mit dem
API-Secret der App (`SHOPIFY_API_SECRET`) – dieser Weg ist empfohlen, damit
ein einziges Secret genügt.

### 5. Leistungen anlegen

1. Im Shopify-Admin Produkte anlegen (z. B. «Fahrstunde Handschaltung,
   50 Minuten», «Fahrstunde Automat, 50 Minuten», Doppellektion, Pakete)
   und einer Kollektion «Fahrstunden» zuordnen. **Preise trägt die
   Betreiberin ein.**
2. Im Backend-Admin (`https://<BACKEND-DOMAIN>/admin`) unter «Leistungen»
   jedes Produkt mit Produkt-ID + Varianten-ID, Dauer, Puffer und
   Getriebeart als Kalenderleistung anlegen. Nur so verknüpfte Produkte
   sind online buchbar.
3. Unter «Arbeitszeiten» die wiederkehrenden Fenster eintragen und unter
   «Einstellungen» Puffer/Hold/Fristen prüfen.

### 6. Theme verbinden

Im Theme-Editor auf der Buchungsseite (Abschnitt «Buchung») die Kollektion
mit den Fahrstunden-Produkten wählen. Der App-Proxy-Pfad ist standardmässig
`/apps/booking` und muss zur App-Konfiguration passen.

## API-Routen (Storefront, hinter dem App Proxy)

| Methode | Route | Zweck |
|---|---|---|
| GET | `/apps/booking/services` | buchbare Leistungen |
| GET | `/apps/booking/availability?from&to&serviceId` | freie Tage + Uhrzeiten |
| POST | `/apps/booking/holds` | Termin atomar reservieren |
| POST | `/apps/booking/holds/:id/extend` | Reservierung verlängern |
| DELETE | `/apps/booking/holds/:id?bookingToken=` | Reservierung freigeben |
| GET | `/apps/booking/bookings/:token` | Buchung ansehen (manage_token) |
| POST | `/apps/booking/bookings/:token/cancel` | stornieren |
| POST | `/apps/booking/bookings/:token/reschedule` | verschieben (atomar) |
| GET | `/apps/booking/bookings/:token/ics` | Kalenderdatei (.ics) |

## Tests

```bash
npm test                       # Logik-Tests (Slots, Puffer, DST) – ohne DB
TEST_DATABASE_URL=postgres://... npm test
                               # zusätzlich Integrationstests (Doppelbuchung,
                               # Webhook-Idempotenz, Verschiebung, …)
```

**Warnung:** `TEST_DATABASE_URL` niemals auf die Produktionsdatenbank zeigen
lassen – die Tests leeren die Tabellen.

## Sicherheit

- App-Proxy-Anfragen: Shopify-Signatur (HMAC) wird serverseitig geprüft
- Webhooks: HMAC über den Raw-Body + idempotente Event-Verarbeitung
- Buchungstoken: zufällig (192 Bit) + HMAC-signiert; Zuordnung von
  Bestellungen ausschliesslich über den Token, nie über Name/E-Mail
- Admin: scrypt-Passwort-Hash, signiertes HttpOnly-Session-Cookie
  (SameSite=Strict), CSRF-Header-Prüfung, Rate Limiting (Login: 5/Min.)
- Keine Secrets im Theme, keine personenbezogenen Daten in URLs
- DSGVO-Webhooks: `customers/redact`, `shop/redact`, `customers/data_request`
