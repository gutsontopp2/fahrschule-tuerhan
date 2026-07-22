/* Admin-Authentifizierung: Passwort-Login (scrypt-Hash aus der Umgebung),
   danach signiertes, zeitlich begrenztes Session-Cookie (HttpOnly,
   SameSite=Strict). CSRF-Schutz: Mutationen verlangen zusätzlich den
   Header X-Requested-With: fetch; SameSite=Strict verhindert Cross-Site-
   Cookie-Versand. */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

const SESSION_HOURS = 12;
const COOKIE_NAME = 'ft_admin';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.appSecret).update(payload).digest('base64url');
}

export function createSessionCookie(res: Response): void {
  const expires = Date.now() + SESSION_HOURS * 3_600_000;
  const payload = `admin.${expires}`;
  const value = `${payload}.${sign(payload)}`;
  res.cookie(COOKIE_NAME, value, {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'strict',
    maxAge: SESSION_HOURS * 3_600_000,
    path: '/admin',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/admin' });
}

export function isValidSession(req: Request): boolean {
  const raw = parseCookies(req)[COOKIE_NAME];
  if (!raw) return false;
  const parts = raw.split('.');
  if (parts.length !== 3) return false;
  const [scope, expiresStr, sig] = parts;
  const payload = `${scope}.${expiresStr}`;
  const expected = sign(payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(expiresStr) > Date.now();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isValidSession(req)) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Bitte anmelden.' });
    return;
  }
  // CSRF: Mutationen nur mit explizitem Fetch-Header
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') {
    res.status(403).json({ code: 'FORBIDDEN', message: 'Ungültige Anfrage.' });
    return;
  }
  next();
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
