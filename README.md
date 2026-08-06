# Fahrschule Türhan – Website & Buchungssystem

Developer handover. This repo contains **two** things:

1. **A Shopify theme** (repo root) – the storefront/website (Liquid, CSS, JS).
2. **A custom booking backend** (`booking-app/`) – a Node/TypeScript + PostgreSQL
   app that powers the online lesson booking (availability, holds, atomic
   double-booking prevention, webhooks, a small admin UI).

> Language note: user-facing copy is Swiss German. Code/comments are mixed
> German/English. Money is CHF, timezone is `Europe/Zurich`.

---

## Repo structure

```
/                      Shopify theme
├─ assets/             base.css, global.js, booking.js, images (e.g. dilek-tuerhan.jpg)
├─ config/             settings_schema.json, settings_data.json (theme settings)
├─ layout/theme.liquid Global layout (loads CSS/JS, cookie banner, mobile CTA bar)
├─ sections/           Storefront sections (hero, fleet, testimonials, footer, …)
├─ snippets/           Reusable partials (booking calendar, nav-links, cookie-banner, …)
├─ templates/          JSON/Liquid templates (index.json, page.buchung.liquid, …)
├─ docs/rechtstexte/   Legal text DRAFTS (Impressum, Datenschutz, AGB, …) with [PLACEHOLDERS]
├─ ABSCHLUSSBERICHT.md Detailed build report (DE)
└─ booking-app/        Booking backend (see below)
```

### Booking backend (`booking-app/`)
```
booking-app/
├─ src/
│  ├─ index.ts            Express bootstrap (proxy + webhooks + admin routes)
│  ├─ availability.ts     Slot computation (pure logic; 50min + configurable buffer, DST-safe)
│  ├─ bookingService.ts   Holds / confirm / cancel / reschedule (transactional)
│  ├─ db.ts, config.ts    Postgres pool + env config
│  ├─ shopify.ts          App-proxy/webhook HMAC + signed booking tokens
│  ├─ adminAuth.ts, rateLimit.ts, notify.ts, ics.ts, migrate.ts
│  └─ routes/             proxy.ts (storefront), webhooks.ts, admin.ts
├─ migrations/001_init.sql  DB schema incl. EXCLUDE constraint (no overlaps)
├─ public/admin/index.html  Protected admin UI (calendar, bookings, hours, services)
├─ test/                     Vitest (logic tests + optional Postgres integration tests)
├─ Dockerfile                Deterministic build (used by Railway)
├─ .env.example              All required env vars
└─ README.md                 Backend setup & API docs  ← read this for the backend
```

---

## How it works (short)

- The storefront calendar (`snippets/booking.liquid` + `assets/booking.js`) talks
  **directly** to the backend over CORS (locked to the shop domain). Backend base
  URL is a theme setting: `settings.booking_backend_url` (Theme editor →
  Buchungssystem). Endpoints live under `/proxy/*` (an optional Shopify App Proxy
  is also supported).
- Booking flow: pick service → date → time → details → server creates an **atomic
  hold** (Postgres `EXCLUDE` constraint prevents overlaps) → product added to
  Shopify cart with signed line-item token → Shopify checkout → `orders/paid`
  webhook confirms the booking.
- Availability rules (working hours, buffer, lead time, max advance), services
  (linked to Shopify variant IDs) and bookings are managed in the backend admin
  at `https://<backend>/admin`.

Full architecture, DB schema and test list: **`ABSCHLUSSBERICHT.md`** and
**`booking-app/README.md`**.

---

## Run it locally

### Theme
There's no build step. Edit Liquid/CSS/JS directly. To preview against the real
store, use Shopify CLI:
```bash
npm i -g @shopify/cli
shopify theme dev --store <your-store>.myshopify.com
```
Lint:
```bash
shopify theme check
```
Deploy: zip the theme folders (`assets config layout locales sections snippets templates`)
and upload in Shopify admin → Online Store → Themes, **or** `shopify theme push`.

### Backend
```bash
cd booking-app
cp .env.example .env      # fill in values (see below)
npm install
npm run migrate           # apply DB schema
npm run dev               # local dev (tsx watch)
npm test                  # logic tests; add TEST_DATABASE_URL for integration tests
```

---

## Live infrastructure (no secrets in this repo)

- **Backend:** deployed on **Railway** (Docker). Health check: `GET /healthz`.
  Env vars are set in Railway (see `booking-app/.env.example` for the full list:
  `DATABASE_URL`, `SHOPIFY_API_SECRET`, `SHOPIFY_SHOP_DOMAIN`, `APP_SECRET`,
  `ADMIN_PASSWORD_HASH`, `PUBLIC_SHOP_URL`, optional SMTP, optional
  `STOREFRONT_ORIGINS` for a custom domain).
- **Database:** PostgreSQL (Railway).
- **Storefront:** Shopify store; the published theme is this repo's content.

Secrets (`.env`, Railway variables, admin password) are **intentionally not in
git**. The owner shares them privately with whoever needs them.

---

## Known TODOs / not finished yet

- Shopify **webhooks** (orders/paid etc.) registration + payment provider setup.
- **Legal pages**: content drafts in `docs/rechtstexte/` still contain
  `[PLACEHOLDERS]` and need legal review before publishing.
- Car images (VW Golf / Hyundai i30) are uploaded via the Theme editor, not in git.
- See `ABSCHLUSSBERICHT.md` → “bekannte Einschränkungen / offene Punkte”.

---

## Branches
- `main` – current state (kept in sync).
- `feature/website-fertigstellung` – working branch (same content as main).
