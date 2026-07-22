/* Führt alle SQL-Migrationen in migrations/ der Reihe nach aus.
   Zusatzfunktion: `npm run migrate -- --hash-password` erzeugt einen
   scrypt-Hash für ADMIN_PASSWORD_HASH (liest das Passwort von stdin). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hashPassword } from './adminAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  if (process.argv.includes('--hash-password')) {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const pw = Buffer.concat(chunks).toString('utf8').trim();
      if (pw.length < 10) {
        console.error('Passwort muss mindestens 10 Zeichen haben.');
        process.exit(1);
      }
      console.log('ADMIN_PASSWORD_HASH=' + hashPassword(pw));
    });
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL ist nicht gesetzt.');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const dir = path.resolve(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [file]);
      if (done.rows[0]) {
        console.log(`übersprungen (bereits angewendet): ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`wende an: ${file}`);
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    }
    console.log('Migrationen abgeschlossen.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
