/* ============================================================
   Integrationstests gegen eine echte PostgreSQL-Datenbank.
   Aktivierung:  TEST_DATABASE_URL=postgres://... npm test
   Die Datenbank wird bei jedem Lauf migriert und geleert –
   NIEMALS eine Produktionsdatenbank angeben!

   Abgedeckt:
   - zwei gleichzeitige Reservierungen auf denselben Termin
   - teilweise überlappende Termine
   - abgelaufene Reservierung wird freigegeben
   - bezahlter Auftrag bestätigt die Buchung
   - doppelt zugestellter Webhook erzeugt keine zweite Verarbeitung
   - stornierte Buchung
   - Terminverschiebung bleibt atomar
   - manipulierte Produkt-/Termindaten werden abgelehnt
   ============================================================ */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DB = process.env.TEST_DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Umgebung für config.ts bereitstellen, bevor Module geladen werden
process.env.DATABASE_URL = TEST_DB ?? 'postgres://unused/unused';
process.env.SHOPIFY_API_SECRET ??= 'test-shopify-secret';
process.env.SHOPIFY_SHOP_DOMAIN ??= 'test.myshopify.com';
process.env.APP_SECRET ??= 'test-app-secret-mindestens-32-zeichen-lang!!';

describe.skipIf(!TEST_DB)('Integration (PostgreSQL)', () => {
  let pool: import('pg').Pool;
  let svc: typeof import('../src/bookingService.js');
  let db: typeof import('../src/db.js');
  let shopify: typeof import('../src/shopify.js');
  let serviceVariantId: string;

  beforeAll(async () => {
    db = await import('../src/db.js');
    svc = await import('../src/bookingService.js');
    shopify = await import('../src/shopify.js');
    pool = db.pool;
    const sql = fs.readFileSync(path.resolve(__dirname, '..', 'migrations', '001_init.sql'), 'utf8');
    await pool.query(sql);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE bookings, webhook_events, manual_slots, availability_exceptions, availability_rules RESTART IDENTITY');
    await pool.query('DELETE FROM services');
    // Mo–So 08:00–17:00, damit Testtermine immer im Fenster liegen
    for (let wd = 1; wd <= 7; wd++) {
      await pool.query(
        `INSERT INTO availability_rules (weekday, start_time, end_time) VALUES ($1,'08:00','17:00')`,
        [wd]
      );
    }
    serviceVariantId = '440000000001';
    await pool.query(
      `INSERT INTO services (shopify_product_id, shopify_variant_id, name, duration_minutes, vehicle_type)
       VALUES (990000000001, $1, 'Fahrstunde Handschaltung', 50, 'handschaltung')`,
      [serviceVariantId]
    );
    await pool.query(`UPDATE settings SET value='0' WHERE key='min_lead_minutes'`);
    await pool.query(`UPDATE settings SET value='365' WHERE key='max_advance_days'`);
  });

  function futureDate(daysAhead = 7): string {
    const d = new Date(Date.now() + daysAhead * 86_400_000);
    return d.toISOString().slice(0, 10);
  }

  function holdRequest(overrides: Partial<import('../src/bookingService.js').HoldRequest> = {}) {
    return {
      variantId: serviceVariantId,
      date: futureDate(),
      time: '12:00',
      customer: { firstName: 'Anna', lastName: 'Muster', email: 'anna@example.com', phone: '+41791234567' },
      meetingPoint: 'Bahnhof Buchs SG',
      vehicleType: 'handschaltung' as const,
      idempotencyKey: 'key-' + Math.random().toString(36).slice(2),
      ...overrides,
    };
  }

  it('normale 50-Minuten-Buchung blockiert 70 Minuten (12:00 → 13:10)', async () => {
    const hold = await svc.createHold(holdRequest());
    const { rows } = await pool.query(
      `SELECT start_at, lesson_end_at, blocked_until,
              to_char(blocked_until AT TIME ZONE 'Europe/Zurich', 'HH24:MI') AS bu_local
         FROM bookings WHERE id=$1`,
      [hold.bookingId]
    );
    const b = rows[0];
    expect(b.lesson_end_at.getTime() - b.start_at.getTime()).toBe(50 * 60_000);
    expect(b.blocked_until.getTime() - b.lesson_end_at.getTime()).toBe(20 * 60_000);
    expect(b.bu_local).toBe('13:10');
  });

  it('nach 12:00-Buchung: 13:00 wird abgelehnt, 13:10 ist buchbar', async () => {
    const date = futureDate();
    await svc.createHold(holdRequest({ date }));
    await expect(svc.createHold(holdRequest({ date, time: '13:00' }))).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    const ok = await svc.createHold(holdRequest({ date, time: '13:10' }));
    expect(ok.bookingId).toBeGreaterThan(0);
  });

  it('zwei gleichzeitige Reservierungen: genau eine gewinnt', async () => {
    const date = futureDate();
    const results = await Promise.allSettled([
      svc.createHold(holdRequest({ date })),
      svc.createHold(holdRequest({ date })),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'SLOT_TAKEN' });
  });

  it('teilweise überlappender Termin wird abgelehnt (12:30 nach 12:00)', async () => {
    const date = futureDate();
    await svc.createHold(holdRequest({ date }));
    await expect(svc.createHold(holdRequest({ date, time: '12:30' }))).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
  });

  it('abgelaufene Reservierung wird freigegeben und der Slot wieder buchbar', async () => {
    const date = futureDate();
    const hold = await svc.createHold(holdRequest({ date }));
    await pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id=$1`, [hold.bookingId]);
    const again = await svc.createHold(holdRequest({ date }));
    expect(again.bookingId).not.toBe(hold.bookingId);
    const { rows } = await pool.query('SELECT status FROM bookings WHERE id=$1', [hold.bookingId]);
    expect(rows[0].status).toBe('expired');
  });

  it('idempotenter Hold: gleicher Idempotency-Key liefert dieselbe Reservierung', async () => {
    const req = holdRequest();
    const a = await svc.createHold(req);
    const b = await svc.createHold(req);
    expect(b.bookingId).toBe(a.bookingId);
  });

  it('bezahlter Auftrag bestätigt die Buchung (held → confirmed)', async () => {
    const hold = await svc.createHold(holdRequest());
    const token = shopify.verifyBookingToken(hold.bookingToken)!;
    await db.withTransaction(async (client) => {
      const outcome = await svc.confirmBooking(client, token.bookingId, token.manageToken, 123456, '#1001');
      expect(outcome).toBe('confirmed');
    });
    const { rows } = await pool.query('SELECT status, shopify_order_number FROM bookings WHERE id=$1', [hold.bookingId]);
    expect(rows[0].status).toBe('confirmed');
    expect(rows[0].shopify_order_number).toBe('#1001');
  });

  it('doppelt zugestellter Webhook wird nur einmal verarbeitet (Event-Id)', async () => {
    const insert = () =>
      pool.query(
        `INSERT INTO webhook_events (provider_event_id, topic, payload_hash, processed_at)
         VALUES ('evt-1','orders/paid','h', now()) ON CONFLICT (provider_event_id) DO NOTHING`
      );
    const first = await insert();
    const second = await insert();
    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(0);
    // Bestätigung selbst ist ebenfalls idempotent:
    const hold = await svc.createHold(holdRequest());
    const token = shopify.verifyBookingToken(hold.bookingToken)!;
    await db.withTransaction(async (c) => {
      expect(await svc.confirmBooking(c, token.bookingId, token.manageToken, 1, '#1')).toBe('confirmed');
    });
    await db.withTransaction(async (c) => {
      expect(await svc.confirmBooking(c, token.bookingId, token.manageToken, 1, '#1')).toBe('already');
    });
  });

  it('stornierte Buchung gibt den Slot frei', async () => {
    const date = futureDate();
    const hold = await svc.createHold(holdRequest({ date }));
    const token = shopify.verifyBookingToken(hold.bookingToken)!;
    await db.withTransaction(async (c) => svc.confirmBooking(c, token.bookingId, token.manageToken, 2, '#2'));
    const result = await svc.cancelBooking(hold.manageToken);
    expect(result.outcome).toBe('cancelled');
    const again = await svc.createHold(holdRequest({ date }));
    expect(again.bookingId).toBeGreaterThan(hold.bookingId);
  });

  it('kurzfristige Stornierung → needs_review statt automatischer Freigabe', async () => {
    const hold = await svc.createHold(holdRequest({ time: '16:00' }));
    const token = shopify.verifyBookingToken(hold.bookingToken)!;
    await db.withTransaction(async (c) => svc.confirmBooking(c, token.bookingId, token.manageToken, 3, '#3'));
    // Termin künstlich in 1 Stunde legen (innerhalb der 24-h-Frist)
    await pool.query(
      `UPDATE bookings SET start_at = now() + interval '1 hour',
              lesson_end_at = now() + interval '1 hour 50 minutes',
              blocked_until = now() + interval '2 hours 10 minutes' WHERE id=$1`,
      [hold.bookingId]
    );
    const result = await svc.cancelBooking(hold.manageToken);
    expect(result.outcome).toBe('needs_review');
  });

  it('Terminverschiebung ist atomar: kein Zustand mit doppelter Belegung', async () => {
    const date = futureDate();
    const hold = await svc.createHold(holdRequest({ date }));
    const token = shopify.verifyBookingToken(hold.bookingToken)!;
    await db.withTransaction(async (c) => svc.confirmBooking(c, token.bookingId, token.manageToken, 4, '#4'));

    const moved = await svc.rescheduleBooking(hold.manageToken, date, '14:20');
    expect(moved.startAt).toBeTruthy();

    // Alte Zeit ist sofort wieder frei, neue Zeit belegt
    const oldSlot = await svc.createHold(holdRequest({ date, time: '12:00' }));
    expect(oldSlot.bookingId).toBeGreaterThan(0);
    await expect(svc.createHold(holdRequest({ date, time: '14:20' }))).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    // Es existiert genau EINE aktive Buchung der verschobenen Reservierung
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM bookings WHERE manage_token=$1 AND status IN ('held','confirmed')`,
      [hold.manageToken]
    );
    expect(rows[0].n).toBe(1);
  });

  it('Verschiebung auf belegten Slot schlägt fehl und lässt den alten Termin unangetastet', async () => {
    const date = futureDate();
    const a = await svc.createHold(holdRequest({ date, time: '12:00' }));
    await svc.createHold(holdRequest({ date, time: '14:20' }));
    await expect(svc.rescheduleBooking(a.manageToken, date, '14:20')).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    const { rows } = await pool.query(
      `SELECT to_char(start_at AT TIME ZONE 'Europe/Zurich','HH24:MI') AS t FROM bookings WHERE id=$1`,
      [a.bookingId]
    );
    expect(rows[0].t).toBe('12:00');
  });

  it('manipulierte Daten werden abgelehnt: unbekannte Variante, Zeit ausserhalb der Öffnungszeiten, Vergangenheit', async () => {
    await expect(svc.createHold(holdRequest({ variantId: '999999' }))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(svc.createHold(holdRequest({ time: '22:00' }))).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await expect(svc.createHold(holdRequest({ date: yesterday }))).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    await expect(
      svc.createHold(holdRequest({ vehicleType: 'automat' })) // Leistung ist Handschaltung
    ).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('Zahlung nach Hold-Ablauf: Slot noch frei → confirmed; Slot vergeben → needs_review', async () => {
    const date = futureDate();
    const hold = await svc.createHold(holdRequest({ date }));
    const token = shopify.verifyBookingToken(hold.bookingToken)!;
    await pool.query(`UPDATE bookings SET status='expired' WHERE id=$1`, [hold.bookingId]);
    await db.withTransaction(async (c) => {
      expect(await svc.confirmBooking(c, token.bookingId, token.manageToken, 5, '#5')).toBe('confirmed');
    });

    // Zweiter Fall: Slot wurde inzwischen neu vergeben
    const hold2 = await svc.createHold(holdRequest({ date, time: '09:10' }));
    const token2 = shopify.verifyBookingToken(hold2.bookingToken)!;
    await pool.query(`UPDATE bookings SET status='expired' WHERE id=$1`, [hold2.bookingId]);
    await svc.createHold(holdRequest({ date, time: '09:10' })); // neuer Kunde nimmt den Slot
    await db.withTransaction(async (c) => {
      expect(await svc.confirmBooking(c, token2.bookingId, token2.manageToken, 6, '#6')).toBe('needs_review');
    });
  });
});

describe.skipIf(!!TEST_DB)('Hinweis', () => {
  it('Integrationstests übersprungen – TEST_DATABASE_URL nicht gesetzt', () => {
    expect(true).toBe(true);
  });
});
