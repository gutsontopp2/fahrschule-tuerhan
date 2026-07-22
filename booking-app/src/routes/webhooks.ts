/* ============================================================
   Shopify-Webhooks. Anforderungen:
   - HMAC über den Raw-Body prüfen
   - Event-ID (X-Shopify-Webhook-Id) speichern und Events idempotent
     verarbeiten – doppelte Zustellung erzeugt keine zweite Buchung
   - Zuordnung ausschliesslich über den signierten Buchungstoken in den
     Line-Item-Properties (nie über Name/E-Mail)
   ============================================================ */
import { Router, raw } from 'express';
import crypto from 'node:crypto';
import { verifyWebhookHmac, verifyBookingToken } from '../shopify.js';
import { withTransaction, pool } from '../db.js';
import { confirmBooking } from '../bookingService.js';
import { sendConfirmationMails, notifyOperator } from '../notify.js';

export const webhookRouter = Router();

// Raw-Body wird für die HMAC-Prüfung benötigt
webhookRouter.use(raw({ type: 'application/json', limit: '2mb' }));

interface LineItemProperty {
  name: string;
  value: string;
}
interface OrderPayload {
  id: number;
  order_number?: number;
  name?: string;
  line_items?: { properties?: LineItemProperty[] }[];
}

function extractBookingTokens(order: OrderPayload): string[] {
  const tokens: string[] = [];
  for (const item of order.line_items ?? []) {
    for (const prop of item.properties ?? []) {
      if (prop.name === '_booking_token' && typeof prop.value === 'string') tokens.push(prop.value);
    }
  }
  return tokens;
}

/**
 * Registriert das Event idempotent. Rückgabe false → bereits verarbeitet.
 * Läuft innerhalb der Verarbeitungstransaktion, damit ein Fehler das
 * Event nicht fälschlich als verarbeitet markiert.
 */
async function registerEvent(
  client: import('pg').PoolClient,
  eventId: string,
  topic: string,
  rawBody: Buffer
): Promise<boolean> {
  const hash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const res = await client.query(
    `INSERT INTO webhook_events (provider_event_id, topic, payload_hash, processed_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (provider_event_id) DO NOTHING`,
    [eventId, topic, hash]
  );
  return (res.rowCount ?? 0) > 0;
}

function webhookHandler(
  topic: string,
  process: (client: import('pg').PoolClient, order: OrderPayload) => Promise<void>
) {
  return async (req: import('express').Request, res: import('express').Response) => {
    const rawBody = req.body as Buffer;
    if (!verifyWebhookHmac(rawBody, req.headers['x-shopify-hmac-sha256'] as string | undefined)) {
      res.status(401).send('invalid hmac');
      return;
    }
    const eventId = String(req.headers['x-shopify-webhook-id'] ?? '');
    if (!eventId) {
      res.status(400).send('missing event id');
      return;
    }
    try {
      const order = JSON.parse(rawBody.toString('utf8')) as OrderPayload;
      await withTransaction(async (client) => {
        const fresh = await registerEvent(client, eventId, topic, rawBody);
        if (!fresh) return; // Duplikat – nichts tun
        await process(client, order);
      });
      res.status(200).send('ok');
    } catch (err) {
      console.error(`[webhook:${topic}] Verarbeitung fehlgeschlagen:`, err);
      // 500 → Shopify stellt erneut zu; registerEvent wurde zurückgerollt
      res.status(500).send('error');
    }
  };
}

/* ---------- Bestellung bezahlt → Buchung bestätigen ---------- */
webhookRouter.post(
  '/orders-paid',
  webhookHandler('orders/paid', async (client, order) => {
    for (const token of extractBookingTokens(order)) {
      const verified = verifyBookingToken(token);
      if (!verified) {
        console.warn('[webhook] Ungültiger Buchungstoken in Bestellung', order.id);
        continue;
      }
      const outcome = await confirmBooking(
        client,
        verified.bookingId,
        verified.manageToken,
        order.id,
        order.name ?? String(order.order_number ?? order.id)
      );
      if (outcome === 'confirmed') {
        // Bestätigungsmails nach Commit (Fire-and-forget, ausserhalb der Transaktion)
        const { rows } = await client.query(
          `SELECT b.*, s.name AS service_name FROM bookings b
             LEFT JOIN services s ON s.id = b.service_id WHERE b.id = $1`,
          [verified.bookingId]
        );
        const b = rows[0];
        if (b) {
          setImmediate(() => {
            sendConfirmationMails({
              bookingId: Number(b.id),
              serviceName: b.service_name ?? 'Fahrstunde',
              startAt: b.start_at,
              lessonEndAt: b.lesson_end_at,
              timezone: b.timezone,
              vehicleType: b.vehicle_type,
              meetingPoint: b.meeting_point,
              customerFirstName: b.customer_first_name,
              customerEmail: b.customer_email,
              orderNumber: b.shopify_order_number,
              manageToken: b.manage_token,
            }).catch((err) => console.error('[mail]', err));
          });
        }
      } else if (outcome === 'needs_review') {
        setImmediate(() => {
          notifyOperator(
            'Buchungskonflikt – bitte prüfen',
            `Bestellung ${order.name ?? order.id} wurde bezahlt, aber der reservierte Termin (Buchung ${verified.bookingId}) ist inzwischen vergeben. Bitte Kundin/Kunden kontaktieren und neu terminieren oder erstatten.`
          ).catch(() => {});
        });
      }
    }
  })
);

/* ---------- Bestellung storniert / erstattet → Buchung stornieren ---------- */
function cancelFromOrder(reason: string) {
  return async (client: import('pg').PoolClient, order: OrderPayload) => {
    for (const token of extractBookingTokens(order)) {
      const verified = verifyBookingToken(token);
      if (!verified) continue;
      await client.query(
        `UPDATE bookings
            SET status = 'cancelled', cancel_reason = $3, updated_at = now()
          WHERE id = $1 AND manage_token = $2 AND status IN ('held', 'confirmed', 'needs_review')`,
        [verified.bookingId, verified.manageToken, reason]
      );
    }
  };
}

webhookRouter.post('/orders-cancelled', webhookHandler('orders/cancelled', cancelFromOrder('Bestellung storniert')));
webhookRouter.post('/refunds-create', webhookHandler('refunds/create', cancelFromOrder('Bestellung erstattet')));

/* ---------- Pflicht-Webhooks Datenschutz (GDPR) ---------- */
webhookRouter.post(
  '/customers-data-request',
  webhookHandler('customers/data_request', async (_client, payload) => {
    setImmediate(() => {
      notifyOperator(
        'Datenauskunft angefordert (Shopify)',
        `Ein Kunde hat über Shopify eine Datenauskunft angefordert. Payload-ID: ${(payload as { id?: number }).id ?? 'n/a'}. Bitte innerhalb von 30 Tagen beantworten.`
      ).catch(() => {});
    });
  })
);

webhookRouter.post(
  '/customers-redact',
  webhookHandler('customers/redact', async (client, payload) => {
    const email = (payload as unknown as { customer?: { email?: string } }).customer?.email;
    if (!email) return;
    // Personenbezogene Daten anonymisieren, Termin-Historie (Zeiten) bleibt erhalten
    await client.query(
      `UPDATE bookings
          SET customer_first_name = NULL, customer_last_name = NULL,
              customer_email = NULL, customer_phone = NULL, customer_note = NULL,
              updated_at = now()
        WHERE lower(customer_email) = lower($1)`,
      [email]
    );
  })
);

webhookRouter.post(
  '/shop-redact',
  webhookHandler('shop/redact', async (client) => {
    // Shop-Löschung: alle personenbezogenen Daten entfernen
    await client.query(
      `UPDATE bookings
          SET customer_first_name = NULL, customer_last_name = NULL,
              customer_email = NULL, customer_phone = NULL, customer_note = NULL`
    );
  })
);

/* Aufräumjob: alte Webhook-Events löschen (>90 Tage) – wird von index.ts periodisch aufgerufen */
export async function cleanupWebhookEvents(): Promise<void> {
  await pool.query(`DELETE FROM webhook_events WHERE received_at < now() - interval '90 days'`);
}
