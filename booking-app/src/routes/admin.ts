/* ============================================================
   Admin-API (geschützt durch Session-Cookie, siehe adminAuth.ts).
   Verwaltet Buchungen, Arbeitszeiten, Ausnahmen, manuelle Slots,
   Leistungen und Einstellungen. Bedient die einfache Admin-UI
   unter /admin.
   ============================================================ */
import { Router, json } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { pool, withTransaction, loadSettings, EXCLUSION_VIOLATION } from '../db.js';
import { config } from '../config.js';
import { rateLimit } from '../rateLimit.js';
import {
  requireAdmin,
  verifyPassword,
  createSessionCookie,
  clearSessionCookie,
} from '../adminAuth.js';
import { slotToUtc } from '../availability.js';
import { SlotTakenError, ValidationError, NotFoundError, expireStaleHolds } from '../bookingService.js';

export const adminRouter = Router();
adminRouter.use(json({ limit: '256kb' }));

function handleError(res: import('express').Response, err: unknown): void {
  if (err instanceof SlotTakenError) res.status(409).json({ code: err.code, message: err.message });
  else if (err instanceof ValidationError) res.status(422).json({ code: err.code, message: err.message });
  else if (err instanceof NotFoundError) res.status(404).json({ code: err.code, message: err.message });
  else if (err instanceof z.ZodError) res.status(422).json({ code: 'INVALID', message: 'Ungültige Eingaben.' });
  else {
    console.error('[admin] Fehler:', err);
    res.status(500).json({ code: 'INTERNAL', message: 'Interner Fehler.' });
  }
}

/* ---------- Login ---------- */
const loginLimiter = rateLimit({ maxPerMinute: 5, keyPrefix: 'admin-login' });

adminRouter.post('/api/login', loginLimiter, (req, res) => {
  const password = String((req.body as { password?: string })?.password ?? '');
  if (!config.adminPasswordHash) {
    res.status(503).json({ code: 'NOT_CONFIGURED', message: 'ADMIN_PASSWORD_HASH ist nicht gesetzt.' });
    return;
  }
  if (!password || !verifyPassword(password, config.adminPasswordHash)) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Falsches Passwort.' });
    return;
  }
  createSessionCookie(res);
  res.json({ ok: true });
});

adminRouter.post('/api/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* Alle folgenden Routen erfordern eine gültige Session */
adminRouter.use('/api', requireAdmin);

/* ---------- Buchungen: Liste / Suche / Kalender ---------- */
adminRouter.get('/api/bookings', async (req, res) => {
  try {
    const q = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        status: z.string().optional(),
        search: z.string().max(120).optional(),
      })
      .parse(req.query);

    await expireStaleHolds(pool);
    const settings = await loadSettings();
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.from) {
      params.push(DateTime.fromISO(q.from, { zone: settings.timezone }).startOf('day').toJSDate());
      where.push(`b.start_at >= $${params.length}`);
    }
    if (q.to) {
      params.push(DateTime.fromISO(q.to, { zone: settings.timezone }).endOf('day').toJSDate());
      where.push(`b.start_at <= $${params.length}`);
    }
    if (q.status) {
      params.push(q.status.split(','));
      where.push(`b.status = ANY($${params.length})`);
    }
    if (q.search) {
      params.push(`%${q.search}%`);
      const p = `$${params.length}`;
      where.push(
        `(b.customer_first_name ILIKE ${p} OR b.customer_last_name ILIKE ${p}
          OR b.customer_email ILIKE ${p} OR b.customer_phone ILIKE ${p}
          OR b.shopify_order_number ILIKE ${p})`
      );
    }
    const { rows } = await pool.query(
      `SELECT b.id, b.status, b.start_at, b.lesson_end_at, b.blocked_until, b.timezone,
              b.customer_first_name, b.customer_last_name, b.customer_email, b.customer_phone,
              b.meeting_point, b.customer_note, b.vehicle_type, b.is_first_lesson,
              b.shopify_order_number, b.cancel_reason, b.hold_expires_at, b.manage_token,
              s.name AS service_name
         FROM bookings b LEFT JOIN services s ON s.id = b.service_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY b.start_at
        LIMIT 500`,
      params
    );
    res.json({ bookings: rows });
  } catch (err) {
    handleError(res, err);
  }
});

/* CSV-Export */
adminRouter.get('/api/bookings.csv', async (req, res) => {
  try {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    const params: unknown[] = [];
    const where: string[] = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      params.push(from);
      where.push(`(b.start_at AT TIME ZONE 'Europe/Zurich')::date >= $${params.length}::date`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      params.push(to);
      where.push(`(b.start_at AT TIME ZONE 'Europe/Zurich')::date <= $${params.length}::date`);
    }
    const { rows } = await pool.query(
      `SELECT b.id, b.status,
              to_char(b.start_at AT TIME ZONE 'Europe/Zurich', 'YYYY-MM-DD') AS datum,
              to_char(b.start_at AT TIME ZONE 'Europe/Zurich', 'HH24:MI') AS von,
              to_char(b.lesson_end_at AT TIME ZONE 'Europe/Zurich', 'HH24:MI') AS bis,
              s.name AS leistung, b.vehicle_type AS getriebe,
              b.customer_first_name AS vorname, b.customer_last_name AS nachname,
              b.customer_email AS email, b.customer_phone AS telefon,
              b.meeting_point AS treffpunkt, b.shopify_order_number AS bestellnummer
         FROM bookings b LEFT JOIN services s ON s.id = b.service_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY b.start_at`,
      params
    );
    const header = Object.keys(
      rows[0] ?? { id: '', status: '', datum: '', von: '', bis: '', leistung: '' }
    );
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [header.join(';'), ...rows.map((r) => header.map((h) => esc(r[h])).join(';'))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="buchungen.csv"');
    res.send('﻿' + csv);
  } catch (err) {
    handleError(res, err);
  }
});

/* ---------- Termin manuell anlegen / Zeit blockieren ---------- */
const manualBookingBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  durationMinutes: z.number().int().min(15).max(480),
  bufferMinutes: z.number().int().min(0).max(60).optional(),
  type: z.enum(['blocked', 'confirmed']),
  serviceId: z.number().int().positive().optional(),
  firstName: z.string().max(80).optional(),
  lastName: z.string().max(80).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(200).optional().or(z.literal('')),
  meetingPoint: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
});

adminRouter.post('/api/bookings', async (req, res) => {
  try {
    const body = manualBookingBody.parse(req.body);
    const result = await withTransaction(async (client) => {
      const settings = await loadSettings(client);
      const buffer = body.bufferMinutes ?? (body.type === 'blocked' ? 0 : settings.bufferMinutes);
      const slot = slotToUtc(body.date, body.time, body.durationMinutes, buffer, settings.timezone);
      if (!slot) throw new ValidationError('Ungültige Zeitangabe.');
      await expireStaleHolds(client);
      try {
        const { rows } = await client.query(
          `INSERT INTO bookings
             (service_id, customer_first_name, customer_last_name, customer_email, customer_phone,
              meeting_point, customer_note, start_at, lesson_end_at, blocked_until, timezone, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id`,
          [
            body.serviceId ?? null,
            body.firstName ?? null,
            body.lastName ?? null,
            body.email || null,
            body.phone ?? null,
            body.meetingPoint ?? null,
            body.note ?? null,
            slot.startAt,
            slot.lessonEndAt,
            slot.blockedUntil,
            settings.timezone,
            body.type,
          ]
        );
        return { id: Number(rows[0].id) };
      } catch (err) {
        if ((err as { code?: string }).code === EXCLUSION_VIOLATION) throw new SlotTakenError();
        throw err;
      }
    });
    res.status(201).json(result);
  } catch (err) {
    handleError(res, err);
  }
});

/* Termin (Admin) verschieben – atomar wie beim Kunden */
adminRouter.post('/api/bookings/:id/move', async (req, res) => {
  try {
    const body = z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/) })
      .parse(req.body);
    await withTransaction(async (client) => {
      const settings = await loadSettings(client);
      const { rows } = await client.query(
        `SELECT b.*, s.duration_minutes AS sd, s.buffer_minutes AS sb
           FROM bookings b LEFT JOIN services s ON s.id = b.service_id
          WHERE b.id = $1 FOR UPDATE OF b`,
        [req.params.id]
      );
      const b = rows[0];
      if (!b) throw new NotFoundError('Buchung nicht gefunden.');
      if (!['held', 'confirmed', 'blocked', 'needs_review'].includes(b.status)) {
        throw new ValidationError('Nur aktive Termine können verschoben werden.');
      }
      const duration = b.sd
        ? Number(b.sd)
        : Math.round((b.lesson_end_at.getTime() - b.start_at.getTime()) / 60000);
      const buffer =
        b.sb !== null && b.sb !== undefined
          ? Number(b.sb)
          : Math.round((b.blocked_until.getTime() - b.lesson_end_at.getTime()) / 60000);
      const slot = slotToUtc(body.date, body.time, duration, buffer, settings.timezone);
      if (!slot) throw new ValidationError('Ungültige Zeitangabe.');
      try {
        await client.query(
          `UPDATE bookings SET start_at=$2, lesson_end_at=$3, blocked_until=$4,
                  status = CASE WHEN status = 'needs_review' THEN 'confirmed' ELSE status END,
                  updated_at=now() WHERE id=$1`,
          [b.id, slot.startAt, slot.lessonEndAt, slot.blockedUntil]
        );
      } catch (err) {
        if ((err as { code?: string }).code === EXCLUSION_VIOLATION) throw new SlotTakenError();
        throw err;
      }
    });
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

adminRouter.post('/api/bookings/:id/cancel', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE bookings SET status='cancelled',
              cancel_reason = COALESCE($2, 'vom Betreiber storniert'), updated_at=now()
        WHERE id=$1 AND status IN ('held','confirmed','blocked','needs_review')
        RETURNING id`,
      [req.params.id, (req.body as { reason?: string })?.reason ?? null]
    );
    if (!result.rows[0]) throw new NotFoundError('Buchung nicht gefunden oder bereits abgeschlossen.');
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

/* ---------- Arbeitszeiten (Regeln) ---------- */
adminRouter.get('/api/rules', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM availability_rules ORDER BY weekday, start_time');
    res.json({ rules: rows });
  } catch (err) {
    handleError(res, err);
  }
});

const ruleBody = z.object({
  weekday: z.number().int().min(1).max(7),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  active: z.boolean().default(true),
});

adminRouter.post('/api/rules', async (req, res) => {
  try {
    const b = ruleBody.parse(req.body);
    if (b.startTime >= b.endTime) throw new ValidationError('Beginn muss vor dem Ende liegen.');
    const { rows } = await pool.query(
      `INSERT INTO availability_rules (weekday, start_time, end_time, active)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [b.weekday, b.startTime, b.endTime, b.active]
    );
    res.status(201).json({ id: Number(rows[0].id) });
  } catch (err) {
    handleError(res, err);
  }
});

adminRouter.delete('/api/rules/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM availability_rules WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

/* ---------- Ausnahmen (Urlaub, Feiertage, Sperren, Sonderöffnung) ---------- */
adminRouter.get('/api/exceptions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, date::text AS date, start_time, end_time, type, reason
         FROM availability_exceptions
        WHERE date >= COALESCE($1::date, CURRENT_DATE - 30)
        ORDER BY date`,
      [req.query.from ?? null]
    );
    res.json({ exceptions: rows });
  } catch (err) {
    handleError(res, err);
  }
});

const exceptionBody = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  type: z.enum(['available', 'blocked', 'holiday', 'vacation']),
  reason: z.string().max(200).optional(),
});

adminRouter.post('/api/exceptions', async (req, res) => {
  try {
    const b = exceptionBody.parse(req.body);
    const from = DateTime.fromISO(b.dateFrom);
    const to = DateTime.fromISO(b.dateTo ?? b.dateFrom);
    if (!from.isValid || !to.isValid || to < from || to.diff(from, 'days').days > 90) {
      throw new ValidationError('Ungültiger Zeitraum (max. 90 Tage).');
    }
    if ((b.startTime && !b.endTime) || (!b.startTime && b.endTime)) {
      throw new ValidationError('Beginn und Ende gemeinsam angeben oder beide leer lassen.');
    }
    if (b.type === 'available' && !b.startTime) {
      throw new ValidationError('Sonderöffnung benötigt Beginn und Ende.');
    }
    await withTransaction(async (client) => {
      for (let d = from; d <= to; d = d.plus({ days: 1 })) {
        await client.query(
          `INSERT INTO availability_exceptions (date, start_time, end_time, type, reason)
           VALUES ($1,$2,$3,$4,$5)`,
          [d.toISODate(), b.startTime ?? null, b.endTime ?? null, b.type, b.reason ?? null]
        );
      }
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

adminRouter.delete('/api/exceptions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM availability_exceptions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

/* ---------- Manuell freigegebene Startzeiten ---------- */
adminRouter.get('/api/manual-slots', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, start_at, service_id, note FROM manual_slots
        WHERE start_at > now() - interval '1 day' ORDER BY start_at`
    );
    res.json({ slots: rows });
  } catch (err) {
    handleError(res, err);
  }
});

adminRouter.post('/api/manual-slots', async (req, res) => {
  try {
    const b = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/),
        serviceId: z.number().int().positive().optional(),
        note: z.string().max(200).optional(),
      })
      .parse(req.body);
    const settings = await loadSettings();
    const start = DateTime.fromISO(`${b.date}T${b.time}`, { zone: settings.timezone });
    if (!start.isValid || start.toFormat('HH:mm') !== b.time) throw new ValidationError('Ungültige Zeit.');
    const { rows } = await pool.query(
      `INSERT INTO manual_slots (start_at, service_id, note) VALUES ($1,$2,$3) RETURNING id`,
      [start.toUTC().toJSDate(), b.serviceId ?? null, b.note ?? null]
    );
    res.status(201).json({ id: Number(rows[0].id) });
  } catch (err) {
    handleError(res, err);
  }
});

adminRouter.delete('/api/manual-slots/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM manual_slots WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

/* ---------- Leistungen ---------- */
adminRouter.get('/api/services', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM services ORDER BY id');
    res.json({ services: rows });
  } catch (err) {
    handleError(res, err);
  }
});

const serviceBody = z.object({
  shopifyProductId: z.union([z.string(), z.number()]).transform((v) => String(v).replace(/\D/g, '')),
  shopifyVariantId: z.union([z.string(), z.number()]).transform((v) => String(v).replace(/\D/g, '')),
  name: z.string().trim().min(2).max(120),
  durationMinutes: z.number().int().min(20).max(240),
  bufferMinutes: z.number().int().min(0).max(60).nullable().optional(),
  vehicleType: z.enum(['handschaltung', 'automat', 'beide']),
  active: z.boolean().default(true),
});

adminRouter.post('/api/services', async (req, res) => {
  try {
    const b = serviceBody.parse(req.body);
    if (!b.shopifyProductId || !b.shopifyVariantId) throw new ValidationError('Produkt-/Varianten-ID fehlt.');
    const { rows } = await pool.query(
      `INSERT INTO services
         (shopify_product_id, shopify_variant_id, name, duration_minutes, buffer_minutes, vehicle_type, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (shopify_variant_id) DO UPDATE
         SET name=$3, duration_minutes=$4, buffer_minutes=$5, vehicle_type=$6, active=$7, updated_at=now()
       RETURNING id`,
      [b.shopifyProductId, b.shopifyVariantId, b.name, b.durationMinutes, b.bufferMinutes ?? null, b.vehicleType, b.active]
    );
    res.status(201).json({ id: Number(rows[0].id) });
  } catch (err) {
    handleError(res, err);
  }
});

adminRouter.patch('/api/services/:id', async (req, res) => {
  try {
    const b = z.object({ active: z.boolean() }).parse(req.body);
    await pool.query('UPDATE services SET active=$2, updated_at=now() WHERE id=$1', [req.params.id, b.active]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

/* ---------- Einstellungen ---------- */
adminRouter.get('/api/settings', async (_req, res) => {
  try {
    res.json({ settings: await loadSettings() });
  } catch (err) {
    handleError(res, err);
  }
});

const settingsBody = z.object({
  bufferMinutes: z.number().int().min(10).max(20), // Vorgabe: 10–20 Minuten
  holdMinutes: z.number().int().min(5).max(60),
  minLeadMinutes: z.number().int().min(0).max(10080),
  maxAdvanceDays: z.number().int().min(1).max(365),
  cancelWindowHours: z.number().int().min(0).max(168),
});

adminRouter.put('/api/settings', async (req, res) => {
  try {
    const b = settingsBody.parse(req.body);
    const entries: [string, number][] = [
      ['buffer_minutes', b.bufferMinutes],
      ['hold_minutes', b.holdMinutes],
      ['min_lead_minutes', b.minLeadMinutes],
      ['max_advance_days', b.maxAdvanceDays],
      ['cancel_window_hours', b.cancelWindowHours],
    ];
    await withTransaction(async (client) => {
      for (const [key, value] of entries) {
        await client.query(
          `INSERT INTO settings (key, value) VALUES ($1,$2)
           ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
          [key, String(value)]
        );
      }
    });
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});
