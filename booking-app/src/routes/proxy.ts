/* ============================================================
   Storefront-Routen für den Buchungskalender.
   Erreichbar auf zwei Wegen:
   1) Direkt vom Theme (Browser) per CORS – erlaubt nur die
      freigegebene(n) Storefront-Domain(s).
   2) Über den Shopify App Proxy (falls installiert) – dann ist
      jede Anfrage von Shopify signiert (Query-Parameter `signature`).
   Alle Zeit-/Buchungsdaten werden serverseitig validiert; Rate-
   Limiting schützt zusätzlich. Es werden keine Secrets ausgeliefert.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { verifyProxySignature, verifyBookingToken } from '../shopify.js';
import { rateLimit } from '../rateLimit.js';
import { config } from '../config.js';
import {
  getAvailability,
  createHold,
  extendHold,
  releaseHold,
  getBookingByManageToken,
  cancelBooking,
  rescheduleBooking,
  listServices,
  SlotTakenError,
  ValidationError,
  NotFoundError,
} from '../bookingService.js';
import { buildIcs } from '../ics.js';
import { pool } from '../db.js';

export const proxyRouter = Router();

/* Erlaubte Storefront-Domains (für direkte CORS-Aufrufe des Kalenders). */
const allowedOrigins = new Set<string>();
allowedOrigins.add(`https://${config.shopDomain}`);
try {
  allowedOrigins.add(new URL(config.publicShopUrl).origin);
} catch {
  /* ungültige PUBLIC_SHOP_URL wird ignoriert */
}
for (const o of config.storefrontOrigins) allowedOrigins.add(o);

function originAllowed(origin: string | undefined): origin is string {
  return !!origin && allowedOrigins.has(origin);
}

/* CORS + Zugriffskontrolle: erlaubt eine Anfrage, wenn sie entweder von einer
   freigegebenen Storefront-Domain kommt (CORS) ODER eine gültige Shopify-App-
   Proxy-Signatur trägt. Alles andere wird mit 401 abgelehnt. */
proxyRouter.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  const fromAllowedOrigin = originAllowed(origin);

  if (fromAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  // CORS-Preflight
  if (req.method === 'OPTIONS') {
    res.status(fromAllowedOrigin ? 204 : 403).end();
    return;
  }

  const devBypass = process.env.ALLOW_UNSIGNED_PROXY === '1' && config.nodeEnv !== 'production';
  const signatureOk = devBypass || verifyProxySignature(req.query as Record<string, unknown>);

  if (!fromAllowedOrigin && !signatureOk) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Ungültige Anfrage.' });
    return;
  }
  next();
});

proxyRouter.use(rateLimit({ maxPerMinute: 60, keyPrefix: 'proxy' }));

function handleError(res: import('express').Response, err: unknown): void {
  if (err instanceof SlotTakenError) {
    res.status(409).json({ code: err.code, message: err.message });
  } else if (err instanceof ValidationError) {
    res.status(422).json({ code: err.code, message: err.message });
  } else if (err instanceof NotFoundError) {
    res.status(404).json({ code: err.code, message: err.message });
  } else {
    console.error('[proxy] Unerwarteter Fehler:', err);
    res.status(500).json({
      code: 'INTERNAL',
      message: 'Es ist ein Fehler aufgetreten. Bitte versuche es erneut oder melde dich telefonisch.',
    });
  }
}

/* ---------- Leistungen ---------- */
proxyRouter.get('/services', async (_req, res) => {
  try {
    const services = await listServices();
    res.json({
      services: services.map((s) => ({
        id: s.id,
        variantId: s.shopifyVariantId,
        name: s.name,
        durationMinutes: s.durationMinutes,
        vehicleType: s.vehicleType,
      })),
    });
  } catch (err) {
    handleError(res, err);
  }
});

/* ---------- Verfügbarkeit ---------- */
const availabilityQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  serviceId: z.coerce.number().int().positive(),
});

proxyRouter.get('/availability', async (req, res) => {
  try {
    const parsed = availabilityQuery.safeParse(req.query);
    if (!parsed.success) throw new ValidationError('Ungültige Anfrage.');
    const { from, to, serviceId } = parsed.data;
    // Zeitraum begrenzen (max. 62 Tage pro Anfrage)
    const span = DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days;
    if (!Number.isFinite(span) || span < 0 || span > 62) throw new ValidationError('Ungültiger Zeitraum.');
    const result = await getAvailability({ fromDate: from, toDate: to, serviceId });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

/* ---------- Hold anlegen ---------- */
const holdBody = z.object({
  variantId: z.union([z.string(), z.number()]).transform(String),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  customer: z.object({
    firstName: z.string().trim().min(2).max(80),
    lastName: z.string().trim().min(2).max(80),
    email: z.string().trim().email().max(200),
    phone: z
      .string()
      .trim()
      .min(7)
      .max(30)
      .regex(/^[+0-9 ()/-]+$/),
  }),
  meetingPoint: z.string().trim().min(2).max(120),
  vehicleType: z.enum(['handschaltung', 'automat']).optional(),
  note: z.string().trim().max(500).optional(),
  isFirstLesson: z.boolean().optional(),
  idempotencyKey: z.string().trim().min(8).max(80),
  cartToken: z.string().trim().max(120).optional(),
  termsAccepted: z.literal(true),
});

proxyRouter.post('/holds', async (req, res) => {
  try {
    const parsed = holdBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Bitte überprüfe deine Angaben (Name, E-Mail, Telefon, Treffpunkt, Bedingungen).');
    }
    const result = await createHold(parsed.data);
    res.status(201).json({
      reservationId: result.bookingId,
      bookingToken: result.bookingToken,
      manageToken: result.manageToken,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    handleError(res, err);
  }
});

/* ---------- Hold verlängern / freigeben ----------
   Autorisierung über den signierten bookingToken – die reine ID genügt nicht. */
const tokenBody = z.object({ bookingToken: z.string().min(10).max(200) });

proxyRouter.post('/holds/:id/extend', async (req, res) => {
  try {
    const parsed = tokenBody.safeParse(req.body);
    const verified = parsed.success ? verifyBookingToken(parsed.data.bookingToken) : null;
    if (!verified || String(verified.bookingId) !== req.params.id) {
      throw new NotFoundError('Reservierung nicht gefunden.');
    }
    const result = await extendHold(verified.bookingId, verified.manageToken);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

proxyRouter.delete('/holds/:id', async (req, res) => {
  try {
    const token = String(req.query.bookingToken ?? '');
    const verified = verifyBookingToken(token);
    if (!verified || String(verified.bookingId) !== req.params.id) {
      throw new NotFoundError('Reservierung nicht gefunden.');
    }
    await releaseHold(verified.bookingId, verified.manageToken);
    res.json({ released: true });
  } catch (err) {
    handleError(res, err);
  }
});

/* ---------- Buchungsverwaltung (Kunde, über manage_token) ---------- */
proxyRouter.get('/bookings/:token', async (req, res) => {
  try {
    const booking = await getBookingByManageToken(req.params.token);
    if (!booking) throw new NotFoundError('Buchung nicht gefunden.');
    res.json({ booking });
  } catch (err) {
    handleError(res, err);
  }
});

proxyRouter.post('/bookings/:token/cancel', async (req, res) => {
  try {
    const result = await cancelBooking(req.params.token);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

const rescheduleBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
});

proxyRouter.post('/bookings/:token/reschedule', async (req, res) => {
  try {
    const parsed = rescheduleBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Ungültige Datums- oder Zeitangabe.');
    const result = await rescheduleBooking(req.params.token, parsed.data.date, parsed.data.time);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

proxyRouter.get('/bookings/:token/ics', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.*, s.name AS service_name FROM bookings b
         LEFT JOIN services s ON s.id = b.service_id
        WHERE b.manage_token = $1 AND b.status IN ('confirmed', 'held')`,
      [req.params.token]
    );
    const b = rows[0];
    if (!b) throw new NotFoundError('Buchung nicht gefunden.');
    const ics = buildIcs({
      uid: `booking-${b.id}`,
      startAt: b.start_at,
      endAt: b.lesson_end_at,
      summary: `Fahrstunde – ${b.service_name ?? 'Fahrschule Türhan'}`,
      description: [
        b.meeting_point ? `Treffpunkt: ${b.meeting_point}` : null,
        'Bitte Lernfahrausweis mitbringen.',
        'Fahrschule Türhan – Mit mir zum Führerschein',
      ]
        .filter(Boolean)
        .join('\n'),
      location: b.meeting_point,
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fahrstunde.ics"');
    res.send(ics);
  } catch (err) {
    handleError(res, err);
  }
});
