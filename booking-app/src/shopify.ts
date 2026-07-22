/* Signatur-Prüfungen für Shopify App Proxy und Webhooks sowie
   signierte Buchungs-Tokens. Keine Vertrauensannahme gegenüber
   Browser-Daten: alles wird serverseitig verifiziert. */
import crypto from 'node:crypto';
import type { Request } from 'express';
import { config } from './config.js';

/** App-Proxy-Signatur (Query-Parameter `signature`) prüfen. */
export function verifyProxySignature(query: Record<string, unknown>): boolean {
  const { signature, ...rest } = query as Record<string, string | string[]>;
  if (typeof signature !== 'string') return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => {
      const value = rest[key];
      return `${key}=${Array.isArray(value) ? value.join(',') : value}`;
    })
    .join('');
  const digest = crypto
    .createHmac('sha256', config.shopifyApiSecret)
    .update(message)
    .digest('hex');
  return safeEqual(digest, signature);
}

/** Webhook-HMAC (Base64 im Header X-Shopify-Hmac-Sha256) über den Raw-Body prüfen. */
export function verifyWebhookHmac(rawBody: Buffer, hmacHeader: string | undefined): boolean {
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', config.shopifyApiSecret)
    .update(rawBody)
    .digest('base64');
  return safeEqual(digest, hmacHeader);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/* ---------- Buchungs-Tokens ----------
   manage_token: zufälliger, nicht erratbarer Token (DB-Spalte) für die
   Kunden-Verwaltungsseite.
   Der im Warenkorb mitgeführte Token ist zusätzlich HMAC-signiert, damit
   Webhooks die Zuordnung manipulationssicher prüfen können. */

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function signBookingToken(bookingId: number | string, manageToken: string): string {
  const payload = `${bookingId}.${manageToken}`;
  const sig = crypto
    .createHmac('sha256', config.appSecret)
    .update(payload)
    .digest('base64url')
    .slice(0, 22);
  return `${payload}.${sig}`;
}

export function verifyBookingToken(token: string): { bookingId: number; manageToken: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [idStr, manageToken, sig] = parts;
  const expected = crypto
    .createHmac('sha256', config.appSecret)
    .update(`${idStr}.${manageToken}`)
    .digest('base64url')
    .slice(0, 22);
  if (!safeEqual(expected, sig)) return null;
  const bookingId = Number(idStr);
  if (!Number.isInteger(bookingId) || bookingId <= 0) return null;
  return { bookingId, manageToken };
}

/** Client-IP hinter Proxy (für Rate Limiting). */
export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}
