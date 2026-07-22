-- ============================================================
-- Fahrschule Türhan – Buchungs-Backend, Schema v1
-- Alle Zeitpunkte werden als timestamptz (UTC) gespeichert und
-- erst für die Anzeige nach Europe/Zurich konvertiert.
-- ============================================================

BEGIN;

-- Für den Exclusion-Constraint gegen überlappende Buchungen
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------- Einstellungen (Schlüssel/Wert) ----------
CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('buffer_minutes', '20'),          -- Puffer nach jeder Fahrstunde (10–20)
  ('hold_minutes', '20'),            -- Dauer einer Reservierung (Hold)
  ('min_lead_minutes', '720'),       -- minimale Vorlaufzeit (12 h)
  ('max_advance_days', '60'),        -- maximale Vorausbuchung
  ('cancel_window_hours', '24'),     -- kostenlose Stornierung bis X Stunden vorher
  ('timezone', 'Europe/Zurich')
ON CONFLICT (key) DO NOTHING;

-- ---------- Leistungen (mit Shopify-Produkt verknüpft) ----------
CREATE TABLE IF NOT EXISTS services (
  id                  bigserial PRIMARY KEY,
  shopify_product_id  bigint NOT NULL,
  shopify_variant_id  bigint NOT NULL UNIQUE,
  name                text   NOT NULL,
  duration_minutes    int    NOT NULL CHECK (duration_minutes BETWEEN 20 AND 240),
  buffer_minutes      int    CHECK (buffer_minutes BETWEEN 0 AND 60), -- NULL = globaler Wert
  vehicle_type        text   NOT NULL DEFAULT 'beide'
                      CHECK (vehicle_type IN ('handschaltung', 'automat', 'beide')),
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------- Wiederkehrende Arbeitszeiten ----------
-- Mehrere Fenster pro Wochentag möglich (z. B. 08:00–12:00 und 13:30–17:00 –
-- damit sind Pausen abgebildet).
CREATE TABLE IF NOT EXISTS availability_rules (
  id          bigserial PRIMARY KEY,
  weekday     int  NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- 1 = Montag (ISO)
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  timezone    text NOT NULL DEFAULT 'Europe/Zurich',
  CHECK (start_time < end_time)
);

-- ---------- Datumsbezogene Ausnahmen ----------
-- type 'available': zusätzliches/abweichendes Fenster an diesem Tag
--   (ersetzt an diesem Datum die Wochenregeln).
-- type 'blocked' | 'holiday' | 'vacation': gesperrter Zeitraum;
--   ohne Uhrzeiten gilt der ganze Tag als gesperrt.
CREATE TABLE IF NOT EXISTS availability_exceptions (
  id          bigserial PRIMARY KEY,
  date        date NOT NULL,
  start_time  time,
  end_time    time,
  type        text NOT NULL CHECK (type IN ('available', 'blocked', 'holiday', 'vacation')),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (start_time IS NULL AND end_time IS NULL)
    OR (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time)
  )
);
CREATE INDEX IF NOT EXISTS availability_exceptions_date_idx ON availability_exceptions (date);

-- ---------- Manuell freigegebene Startzeiten ----------
CREATE TABLE IF NOT EXISTS manual_slots (
  id          bigserial PRIMARY KEY,
  start_at    timestamptz NOT NULL,
  service_id  bigint REFERENCES services (id) ON DELETE CASCADE, -- NULL = für alle Leistungen
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS manual_slots_start_idx ON manual_slots (start_at);

-- ---------- Buchungen ----------
-- status:
--   held       – vorübergehend reserviert (hold_expires_at gesetzt)
--   confirmed  – bezahlt/bestätigt
--   blocked    – vom Betreiber blockierte Zeit / manueller Termin
--   cancelled  – storniert
--   expired    – Reservierung abgelaufen
--   needs_review – Zahlung eingegangen, aber Konflikt/kurzfristige Stornierung → manuell prüfen
CREATE TABLE IF NOT EXISTS bookings (
  id                    bigserial PRIMARY KEY,
  service_id            bigint REFERENCES services (id),
  customer_first_name   text,
  customer_last_name    text,
  customer_email        text,
  customer_phone        text,
  meeting_point         text,
  customer_note         text,
  vehicle_type          text CHECK (vehicle_type IN ('handschaltung', 'automat')),
  is_first_lesson       boolean NOT NULL DEFAULT false,
  start_at              timestamptz NOT NULL,
  lesson_end_at         timestamptz NOT NULL,
  blocked_until         timestamptz NOT NULL,   -- lesson_end_at + Puffer
  timezone              text NOT NULL DEFAULT 'Europe/Zurich',
  status                text NOT NULL CHECK (status IN
                          ('held', 'confirmed', 'blocked', 'cancelled', 'expired', 'needs_review')),
  hold_expires_at       timestamptz,
  manage_token          text UNIQUE,            -- zufälliger Token für die Kunden-Verwaltungsseite
  shopify_cart_token    text,
  shopify_order_id      bigint,
  shopify_order_number  text,
  idempotency_key       text UNIQUE,
  cancel_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (start_at < lesson_end_at AND lesson_end_at <= blocked_until)
);

-- Harte Sperre gegen Doppel-/Überlappungsbuchungen auf Datenbankebene.
-- Zwei parallele Transaktionen können niemals beide einen überlappenden
-- aktiven Zeitraum eintragen – die zweite erhält 23P01 (exclusion_violation).
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (tstzrange(start_at, blocked_until, '[)') WITH &&)
  WHERE (status IN ('held', 'confirmed', 'blocked'));

CREATE INDEX IF NOT EXISTS bookings_start_idx  ON bookings (start_at);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status);
CREATE INDEX IF NOT EXISTS bookings_order_idx  ON bookings (shopify_order_id);

-- ---------- Webhook-Ereignisse (Idempotenz) ----------
CREATE TABLE IF NOT EXISTS webhook_events (
  id                 bigserial PRIMARY KEY,
  provider_event_id  text NOT NULL UNIQUE,  -- X-Shopify-Webhook-Id
  topic              text NOT NULL,
  processed_at       timestamptz,
  payload_hash       text,
  received_at        timestamptz NOT NULL DEFAULT now()
);

COMMIT;
