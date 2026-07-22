/* ============================================================
   Kernlogik: Verfügbarkeit laden, Holds atomar anlegen/verlängern/
   freigeben, Buchungen bestätigen, stornieren und verschieben.
   Alle kritischen Operationen laufen in einer Transaktion; der
   Exclusion-Constraint `bookings_no_overlap` ist die letzte
   Verteidigungslinie gegen Doppelbuchungen.
   ============================================================ */
import type pg from 'pg';
import { DateTime } from 'luxon';
import { pool, withTransaction, loadSettings, EXCLUSION_VIOLATION, UNIQUE_VIOLATION } from './db.js';
import type { AppSettings } from './db.js';
import { computeSlots, slotToUtc } from './availability.js';
import type { Rule, ExceptionRow, BusyInterval } from './availability.js';
import { randomToken, signBookingToken } from './shopify.js';

export class SlotTakenError extends Error {
  code = 'SLOT_TAKEN' as const;
  constructor() {
    super('Dieser Termin wurde gerade vergeben. Bitte wähle einen anderen Termin.');
  }
}
export class ValidationError extends Error {
  code = 'INVALID' as const;
}
export class NotFoundError extends Error {
  code = 'NOT_FOUND' as const;
}

export interface Service {
  id: number;
  shopifyProductId: string;
  shopifyVariantId: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number | null;
  vehicleType: 'handschaltung' | 'automat' | 'beide';
  active: boolean;
}

function mapService(r: Record<string, unknown>): Service {
  return {
    id: Number(r.id),
    shopifyProductId: String(r.shopify_product_id),
    shopifyVariantId: String(r.shopify_variant_id),
    name: String(r.name),
    durationMinutes: Number(r.duration_minutes),
    bufferMinutes: r.buffer_minutes === null ? null : Number(r.buffer_minutes),
    vehicleType: r.vehicle_type as Service['vehicleType'],
    active: Boolean(r.active),
  };
}

export async function listServices(onlyActive = true): Promise<Service[]> {
  const { rows } = await pool.query(
    `SELECT * FROM services ${onlyActive ? 'WHERE active' : ''} ORDER BY duration_minutes, name`
  );
  return rows.map(mapService);
}

export async function getServiceByVariant(variantId: string | number): Promise<Service | null> {
  const { rows } = await pool.query('SELECT * FROM services WHERE shopify_variant_id = $1', [variantId]);
  return rows[0] ? mapService(rows[0]) : null;
}

/* ---------- Verfügbarkeit ---------- */

async function loadAvailabilityInputs(
  client: pg.PoolClient | pg.Pool,
  fromUtc: Date,
  toUtc: Date
): Promise<{ rules: Rule[]; exceptions: ExceptionRow[]; busy: BusyInterval[]; manualStarts: Date[] }> {
  const [rulesRes, excRes, busyRes, manualRes] = await Promise.all([
    client.query('SELECT weekday, start_time, end_time, active FROM availability_rules WHERE active'),
    client.query(
      `SELECT date::text AS date, start_time, end_time, type
         FROM availability_exceptions
        WHERE date BETWEEN ($1::timestamptz AT TIME ZONE 'Europe/Zurich')::date - 1
                       AND ($2::timestamptz AT TIME ZONE 'Europe/Zurich')::date + 1`,
      [fromUtc, toUtc]
    ),
    client.query(
      `SELECT start_at, blocked_until
         FROM bookings
        WHERE status IN ('held', 'confirmed', 'blocked')
          AND blocked_until > $1 AND start_at < $2`,
      [fromUtc, toUtc]
    ),
    client.query('SELECT start_at FROM manual_slots WHERE start_at BETWEEN $1 AND $2', [fromUtc, toUtc]),
  ]);

  const hhmm = (t: string) => t.slice(0, 5);
  return {
    rules: rulesRes.rows.map((r) => ({
      weekday: Number(r.weekday),
      startTime: hhmm(String(r.start_time)),
      endTime: hhmm(String(r.end_time)),
      active: true,
    })),
    exceptions: excRes.rows.map((r) => ({
      date: String(r.date),
      startTime: r.start_time ? hhmm(String(r.start_time)) : null,
      endTime: r.end_time ? hhmm(String(r.end_time)) : null,
      type: r.type,
    })),
    busy: busyRes.rows.map((r) => ({ start: r.start_at, end: r.blocked_until })),
    manualStarts: manualRes.rows.map((r) => r.start_at),
  };
}

export async function getAvailability(params: {
  fromDate: string;
  toDate: string;
  serviceId: number;
}): Promise<{ days: Record<string, string[]>; durationMinutes: number; bufferMinutes: number }> {
  const settings = await loadSettings();
  const { rows } = await pool.query('SELECT * FROM services WHERE id = $1 AND active', [params.serviceId]);
  if (!rows[0]) throw new NotFoundError('Leistung nicht gefunden');
  const service = mapService(rows[0]);
  const buffer = service.bufferMinutes ?? settings.bufferMinutes;

  const zone = settings.timezone;
  const fromUtc = DateTime.fromISO(params.fromDate, { zone }).startOf('day').toUTC().toJSDate();
  const toUtc = DateTime.fromISO(params.toDate, { zone }).endOf('day').toUTC().toJSDate();
  if (Number.isNaN(fromUtc.getTime()) || Number.isNaN(toUtc.getTime())) {
    throw new ValidationError('Ungültiger Zeitraum');
  }

  // Abgelaufene Holds gelten nicht mehr als belegt – opportunistisch bereinigen
  await expireStaleHolds(pool);

  const inputs = await loadAvailabilityInputs(pool, fromUtc, toUtc);
  const days = computeSlots({
    fromDate: params.fromDate,
    toDate: params.toDate,
    durationMinutes: service.durationMinutes,
    bufferMinutes: buffer,
    timezone: zone,
    rules: inputs.rules,
    exceptions: inputs.exceptions,
    busy: inputs.busy,
    manualStarts: inputs.manualStarts,
    now: new Date(),
    minLeadMinutes: settings.minLeadMinutes,
    maxAdvanceDays: settings.maxAdvanceDays,
  });
  return { days, durationMinutes: service.durationMinutes, bufferMinutes: buffer };
}

/** Abgelaufene Holds freigeben (Status → expired). */
export async function expireStaleHolds(q: pg.Pool | pg.PoolClient): Promise<number> {
  const res = await q.query(
    `UPDATE bookings SET status = 'expired', updated_at = now()
      WHERE status = 'held' AND hold_expires_at < now()`
  );
  return res.rowCount ?? 0;
}

/* ---------- Hold anlegen ---------- */

export interface HoldRequest {
  variantId: string;
  date: string; // YYYY-MM-DD (lokal)
  time: string; // HH:MM (lokal)
  customer: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  meetingPoint: string;
  vehicleType?: 'handschaltung' | 'automat';
  note?: string;
  isFirstLesson?: boolean;
  idempotencyKey: string;
  cartToken?: string;
}

export interface HoldResult {
  bookingId: number;
  /** Signierter Token für Warenkorb/Webhook-Zuordnung */
  bookingToken: string;
  /** Token für die Kunden-Verwaltungsseite */
  manageToken: string;
  expiresAt: string; // ISO UTC
  startAt: string;
  lessonEndAt: string;
}

export async function createHold(reqData: HoldRequest): Promise<HoldResult> {
  const service = await getServiceByVariant(reqData.variantId);
  if (!service || !service.active) {
    throw new ValidationError('Diese Leistung ist nicht buchbar. Bitte lade die Seite neu.');
  }
  // Fahrzeugart serverseitig validieren
  if (service.vehicleType !== 'beide') {
    if (reqData.vehicleType && reqData.vehicleType !== service.vehicleType) {
      throw new ValidationError('Die gewählte Getriebeart passt nicht zur Leistung.');
    }
    reqData.vehicleType = service.vehicleType;
  } else if (!reqData.vehicleType) {
    throw new ValidationError('Bitte wähle Handschaltung oder Automat.');
  }

  return withTransaction(async (client) => {
    const settings = await loadSettings(client);
    const buffer = service.bufferMinutes ?? settings.bufferMinutes;

    // Idempotenz: gleicher Schlüssel → bestehendes Ergebnis zurückgeben
    const existing = await client.query(
      `SELECT id, manage_token, hold_expires_at, start_at, lesson_end_at, status
         FROM bookings WHERE idempotency_key = $1`,
      [reqData.idempotencyKey]
    );
    if (existing.rows[0]) {
      const b = existing.rows[0];
      if (b.status === 'held' && b.hold_expires_at > new Date()) {
        return {
          bookingId: Number(b.id),
          bookingToken: signBookingToken(b.id, b.manage_token),
          manageToken: b.manage_token,
          expiresAt: b.hold_expires_at.toISOString(),
          startAt: b.start_at.toISOString(),
          lessonEndAt: b.lesson_end_at.toISOString(),
        };
      }
      throw new SlotTakenError();
    }

    const slot = slotToUtc(reqData.date, reqData.time, service.durationMinutes, buffer, settings.timezone);
    if (!slot) throw new ValidationError('Ungültige Datums- oder Zeitangabe.');

    // Serverseitige Prüfung: Slot muss tatsächlich angeboten werden
    // (Arbeitszeiten, Ausnahmen, Vorlauf, Vorausbuchung – nie dem Browser vertrauen)
    await expireStaleHolds(client);
    const inputs = await loadAvailabilityInputs(client, slot.startAt, slot.blockedUntil);
    const offered = computeSlots({
      fromDate: reqData.date,
      toDate: reqData.date,
      durationMinutes: service.durationMinutes,
      bufferMinutes: buffer,
      timezone: settings.timezone,
      rules: inputs.rules,
      exceptions: inputs.exceptions,
      busy: inputs.busy,
      manualStarts: inputs.manualStarts,
      now: new Date(),
      minLeadMinutes: settings.minLeadMinutes,
      maxAdvanceDays: settings.maxAdvanceDays,
    });
    if (!offered[reqData.date]?.includes(reqData.time)) {
      // Entweder belegt oder ausserhalb der Verfügbarkeit
      throw new SlotTakenError();
    }

    const manageToken = randomToken();
    try {
      const inserted = await client.query(
        `INSERT INTO bookings
           (service_id, customer_first_name, customer_last_name, customer_email, customer_phone,
            meeting_point, customer_note, vehicle_type, is_first_lesson,
            start_at, lesson_end_at, blocked_until, timezone, status, hold_expires_at,
            manage_token, shopify_cart_token, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'held',
                 now() + make_interval(mins => $14), $15, $16, $17)
         RETURNING id, hold_expires_at, start_at, lesson_end_at`,
        [
          service.id,
          reqData.customer.firstName,
          reqData.customer.lastName,
          reqData.customer.email,
          reqData.customer.phone,
          reqData.meetingPoint,
          reqData.note ?? null,
          reqData.vehicleType ?? null,
          reqData.isFirstLesson ?? false,
          slot.startAt,
          slot.lessonEndAt,
          slot.blockedUntil,
          settings.timezone,
          settings.holdMinutes,
          manageToken,
          reqData.cartToken ?? null,
          reqData.idempotencyKey,
        ]
      );
      const row = inserted.rows[0];
      return {
        bookingId: Number(row.id),
        bookingToken: signBookingToken(row.id, manageToken),
        manageToken,
        expiresAt: row.hold_expires_at.toISOString(),
        startAt: row.start_at.toISOString(),
        lessonEndAt: row.lesson_end_at.toISOString(),
      };
    } catch (err) {
      const pgErr = err as { code?: string };
      if (pgErr.code === EXCLUSION_VIOLATION) throw new SlotTakenError();
      if (pgErr.code === UNIQUE_VIOLATION) throw new SlotTakenError();
      throw err;
    }
  });
}

/* ---------- Hold verlängern / freigeben ---------- */

export async function extendHold(bookingId: number, manageToken: string): Promise<{ expiresAt: string }> {
  return withTransaction(async (client) => {
    const settings = await loadSettings(client);
    const res = await client.query(
      `UPDATE bookings
          SET hold_expires_at = GREATEST(hold_expires_at, now() + make_interval(mins => $3)),
              updated_at = now()
        WHERE id = $1 AND manage_token = $2 AND status = 'held' AND hold_expires_at > now()
        RETURNING hold_expires_at`,
      [bookingId, manageToken, settings.holdMinutes]
    );
    if (!res.rows[0]) throw new NotFoundError('Reservierung nicht (mehr) aktiv.');
    return { expiresAt: res.rows[0].hold_expires_at.toISOString() };
  });
}

export async function releaseHold(bookingId: number, manageToken: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE bookings SET status = 'cancelled', cancel_reason = 'vom Kunden freigegeben', updated_at = now()
      WHERE id = $1 AND manage_token = $2 AND status = 'held'`,
    [bookingId, manageToken]
  );
  return (res.rowCount ?? 0) > 0;
}

/* ---------- Bestätigen (Webhook: Bestellung bezahlt) ---------- */

export async function confirmBooking(
  client: pg.PoolClient,
  bookingId: number,
  manageToken: string,
  orderId: string | number,
  orderNumber: string
): Promise<'confirmed' | 'needs_review' | 'already' | 'not_found'> {
  const res = await client.query('SELECT id, status, manage_token FROM bookings WHERE id = $1 FOR UPDATE', [
    bookingId,
  ]);
  const row = res.rows[0];
  if (!row || row.manage_token !== manageToken) return 'not_found';
  if (row.status === 'confirmed') return 'already';

  try {
    // Auch eine inzwischen abgelaufene Reservierung wird wieder aktiviert,
    // sofern der Slot nicht neu vergeben wurde (Exclusion-Constraint prüft das).
    await client.query(
      `UPDATE bookings
          SET status = 'confirmed', shopify_order_id = $2, shopify_order_number = $3,
              hold_expires_at = NULL, updated_at = now()
        WHERE id = $1`,
      [bookingId, orderId, orderNumber]
    );
    return 'confirmed';
  } catch (err) {
    if ((err as { code?: string }).code === EXCLUSION_VIOLATION) {
      // Slot wurde nach Ablauf des Holds neu vergeben → manuelle Prüfung
      await client.query(
        `UPDATE bookings
            SET status = 'needs_review', shopify_order_id = $2, shopify_order_number = $3,
                cancel_reason = 'Zahlung nach Ablauf der Reservierung – Termin inzwischen vergeben',
                updated_at = now()
          WHERE id = $1`,
        [bookingId, orderId, orderNumber]
      );
      return 'needs_review';
    }
    throw err;
  }
}

/* ---------- Stornieren / Verschieben (Kunde) ---------- */

export interface BookingView {
  id: number;
  status: string;
  serviceName: string | null;
  durationMinutes: number | null;
  vehicleType: string | null;
  meetingPoint: string | null;
  startAt: string;
  lessonEndAt: string;
  timezone: string;
  orderNumber: string | null;
  cancelable: boolean;
  cancelWindowHours: number;
}

export async function getBookingByManageToken(manageToken: string): Promise<BookingView | null> {
  const settings = await loadSettings();
  const { rows } = await pool.query(
    `SELECT b.*, s.name AS service_name, s.duration_minutes AS service_duration
       FROM bookings b LEFT JOIN services s ON s.id = b.service_id
      WHERE b.manage_token = $1`,
    [manageToken]
  );
  const b = rows[0];
  if (!b) return null;
  const cancelDeadline = new Date(b.start_at.getTime() - settings.cancelWindowHours * 3_600_000);
  return {
    id: Number(b.id),
    status: b.status,
    serviceName: b.service_name,
    durationMinutes: b.service_duration ? Number(b.service_duration) : null,
    vehicleType: b.vehicle_type,
    meetingPoint: b.meeting_point,
    startAt: b.start_at.toISOString(),
    lessonEndAt: b.lesson_end_at.toISOString(),
    timezone: b.timezone,
    orderNumber: b.shopify_order_number,
    cancelable: b.status === 'confirmed' && new Date() < cancelDeadline,
    cancelWindowHours: settings.cancelWindowHours,
  };
}

export async function cancelBooking(
  manageToken: string
): Promise<{ outcome: 'cancelled' | 'needs_review' }> {
  return withTransaction(async (client) => {
    const settings = await loadSettings(client);
    const { rows } = await client.query(
      `SELECT id, status, start_at FROM bookings WHERE manage_token = $1 FOR UPDATE`,
      [manageToken]
    );
    const b = rows[0];
    if (!b) throw new NotFoundError('Buchung nicht gefunden.');
    if (b.status === 'held') {
      await client.query(
        `UPDATE bookings SET status = 'cancelled', cancel_reason = 'vom Kunden storniert', updated_at = now() WHERE id = $1`,
        [b.id]
      );
      return { outcome: 'cancelled' as const };
    }
    if (b.status !== 'confirmed') throw new ValidationError('Diese Buchung kann nicht mehr storniert werden.');

    const deadline = new Date(b.start_at.getTime() - settings.cancelWindowHours * 3_600_000);
    if (new Date() < deadline) {
      await client.query(
        `UPDATE bookings SET status = 'cancelled', cancel_reason = 'fristgerecht vom Kunden storniert', updated_at = now() WHERE id = $1`,
        [b.id]
      );
      return { outcome: 'cancelled' as const };
    }
    // Kurzfristig: keine automatische Rückerstattung – manuelle Prüfung
    await client.query(
      `UPDATE bookings SET status = 'needs_review',
              cancel_reason = 'kurzfristige Stornierung durch Kunden – manuell prüfen', updated_at = now()
        WHERE id = $1`,
      [b.id]
    );
    return { outcome: 'needs_review' as const };
  });
}

/**
 * Verschiebt eine bestätigte Buchung atomar auf einen freien Slot.
 * Alte und neue Zeit werden in EINER Transaktion getauscht: das UPDATE
 * ändert die Zeiten der bestehenden Zeile; der Exclusion-Constraint prüft
 * Überlappungen mit allen anderen aktiven Buchungen. Es gibt keine
 * Zwischenphase mit zwei aktiven oder null aktiven Terminen.
 */
export async function rescheduleBooking(
  manageToken: string,
  newDate: string,
  newTime: string
): Promise<{ startAt: string }> {
  return withTransaction(async (client) => {
    const settings = await loadSettings(client);
    const { rows } = await client.query(
      `SELECT b.*, s.duration_minutes AS service_duration, s.buffer_minutes AS service_buffer, s.id AS sid
         FROM bookings b JOIN services s ON s.id = b.service_id
        WHERE b.manage_token = $1 FOR UPDATE OF b`,
      [manageToken]
    );
    const b = rows[0];
    if (!b) throw new NotFoundError('Buchung nicht gefunden.');
    if (b.status !== 'confirmed' && b.status !== 'held') {
      throw new ValidationError('Diese Buchung kann nicht verschoben werden.');
    }
    const deadline = new Date(b.start_at.getTime() - settings.cancelWindowHours * 3_600_000);
    if (b.status === 'confirmed' && new Date() >= deadline) {
      throw new ValidationError(
        `Verschieben ist nur bis ${settings.cancelWindowHours} Stunden vor dem Termin möglich. Bitte melde dich telefonisch.`
      );
    }

    const duration = Number(b.service_duration);
    const buffer = b.service_buffer === null ? settings.bufferMinutes : Number(b.service_buffer);
    const slot = slotToUtc(newDate, newTime, duration, buffer, settings.timezone);
    if (!slot) throw new ValidationError('Ungültige Datums- oder Zeitangabe.');

    // Neuer Slot muss regulär angeboten werden (die eigene Buchung zählt dabei nicht als belegt)
    await expireStaleHolds(client);
    const inputs = await loadAvailabilityInputs(client, slot.startAt, slot.blockedUntil);
    const ownStart = (b.start_at as Date).getTime();
    inputs.busy = inputs.busy.filter((x) => x.start.getTime() !== ownStart);
    const offered = computeSlots({
      fromDate: newDate,
      toDate: newDate,
      durationMinutes: duration,
      bufferMinutes: buffer,
      timezone: settings.timezone,
      rules: inputs.rules,
      exceptions: inputs.exceptions,
      busy: inputs.busy,
      manualStarts: inputs.manualStarts,
      now: new Date(),
      minLeadMinutes: settings.minLeadMinutes,
      maxAdvanceDays: settings.maxAdvanceDays,
    });
    if (!offered[newDate]?.includes(newTime)) throw new SlotTakenError();

    try {
      await client.query(
        `UPDATE bookings SET start_at = $2, lesson_end_at = $3, blocked_until = $4, updated_at = now()
          WHERE id = $1`,
        [b.id, slot.startAt, slot.lessonEndAt, slot.blockedUntil]
      );
    } catch (err) {
      if ((err as { code?: string }).code === EXCLUSION_VIOLATION) throw new SlotTakenError();
      throw err;
    }
    return { startAt: slot.startAt.toISOString() };
  });
}
