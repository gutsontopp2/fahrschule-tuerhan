/* Server-Bootstrap: App Proxy, Webhooks, Admin-API und Admin-UI. */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { proxyRouter } from './routes/proxy.js';
import { webhookRouter, cleanupWebhookEvents } from './routes/webhooks.js';
import { adminRouter } from './routes/admin.js';
import { isValidSession } from './adminAuth.js';
import { pool } from './db.js';
import { expireStaleHolds } from './bookingService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

/* Webhooks brauchen den Raw-Body → vor json() einhängen */
app.use('/webhooks', webhookRouter);

/* App-Proxy-Routen (Shopify leitet /apps/booking/* hierher) */
app.use(express.json({ limit: '128kb' }));
app.use('/proxy', proxyRouter);

/* Admin */
app.use('/admin', adminRouter);
app.get('/admin', (req, res) => {
  // UI ausliefern; die Seite selbst zeigt ohne Session nur das Login-Formular
  void req;
  res.sendFile(path.resolve(__dirname, '..', 'public', 'admin', 'index.html'));
});
app.get('/admin/session', (req, res) => {
  res.json({ authenticated: isValidSession(req) });
});

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

/* Periodische Aufräumarbeiten */
const cleanupTimer = setInterval(() => {
  expireStaleHolds(pool).catch(() => {});
  cleanupWebhookEvents().catch(() => {});
}, 60_000);
cleanupTimer.unref?.();

app.listen(config.port, () => {
  console.log(`Buchungs-Backend läuft auf Port ${config.port} (${config.nodeEnv})`);
});
