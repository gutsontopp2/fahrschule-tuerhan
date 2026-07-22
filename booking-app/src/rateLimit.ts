/* Einfaches In-Memory-Rate-Limiting (Token-Bucket pro Schlüssel).
   Für eine Ein-Instanz-Installation ausreichend; bei mehreren Instanzen
   durch einen zentralen Store (z. B. Redis) ersetzen. */
import type { Request, Response, NextFunction } from 'express';
import { clientIp } from './shopify.js';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function rateLimit(opts: { maxPerMinute: number; keyPrefix: string }) {
  const buckets = new Map<string, Bucket>();
  const ratePerMs = opts.maxPerMinute / 60_000;

  // Speicher regelmässig aufräumen
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, b] of buckets) if (b.updatedAt < cutoff) buckets.delete(k);
  }, 5 * 60_000);
  cleanup.unref?.();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${opts.keyPrefix}:${clientIp(req)}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: opts.maxPerMinute, updatedAt: now };
      buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(opts.maxPerMinute, bucket.tokens + (now - bucket.updatedAt) * ratePerMs);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      res.status(429).json({
        code: 'RATE_LIMITED',
        message: 'Zu viele Anfragen. Bitte warte einen Moment und versuche es erneut.',
      });
      return;
    }
    bucket.tokens -= 1;
    next();
  };
}
