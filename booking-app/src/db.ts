import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

/** Führt fn in einer Transaktion aus; Rollback bei Fehler. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface AppSettings {
  bufferMinutes: number;
  holdMinutes: number;
  minLeadMinutes: number;
  maxAdvanceDays: number;
  cancelWindowHours: number;
  timezone: string;
}

export async function loadSettings(client?: pg.PoolClient): Promise<AppSettings> {
  const q = client ?? pool;
  const { rows } = await q.query('SELECT key, value FROM settings');
  const map = new Map(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  const num = (key: string, fallback: number) => {
    const n = Number(map.get(key));
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    bufferMinutes: Math.min(60, Math.max(0, num('buffer_minutes', 20))),
    holdMinutes: num('hold_minutes', 20),
    minLeadMinutes: num('min_lead_minutes', 720),
    maxAdvanceDays: num('max_advance_days', 60),
    cancelWindowHours: num('cancel_window_hours', 24),
    timezone: map.get('timezone') ?? 'Europe/Zurich',
  };
}

/** PostgreSQL-Fehlercode für verletzten Exclusion-Constraint (Überlappung). */
export const EXCLUSION_VIOLATION = '23P01';
export const UNIQUE_VIOLATION = '23505';
