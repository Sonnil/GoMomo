#!/usr/bin/env node
/**
 * pg-daemon.mjs — Keep embedded PostgreSQL running as a background daemon.
 *
 * This script starts (or re-attaches to) the embedded PG instance,
 * creates the database if needed, runs migrations + seed, then stays
 * alive to keep the PG process running.
 *
 * It writes its own PID to .pg-daemon.pid for easy shutdown.
 *
 * Usage:
 *   nohup node scripts/pg-daemon.mjs >> .logs/pg.log 2>&1 &
 *
 * Stop:
 *   kill $(cat .pg-daemon.pid)    OR    npm run demo:stop
 */

import { createRequire } from 'module';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PG_DATA = path.join(ROOT, '.pg-data');
const BACKEND = path.join(ROOT, 'src', 'backend');
const PID_FILE = path.join(ROOT, '.pg-daemon.pid');

const require = createRequire(import.meta.url);

async function main() {
  // Write PID file
  writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  console.log(`[pg-daemon] PID ${process.pid} — starting…`);

  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const pg = new EmbeddedPostgres({
    databaseDir: PG_DATA,
    user: 'receptionist',
    password: 'receptionist_dev',
    port: 5432,
    persistent: true,
  });

  // Initialise if needed
  const pgVersionFile = path.join(PG_DATA, 'PG_VERSION');
  if (!existsSync(pgVersionFile)) {
    console.log('[pg-daemon] Initialising new data directory…');
    await pg.initialise();
  }

  await pg.start();
  console.log('[pg-daemon] PostgreSQL running on port 5432');

  // Create database if needed
  try {
    await pg.createDatabase('receptionist');
    console.log('[pg-daemon] Database "receptionist" created');
  } catch (e) {
    if (!String(e).includes('already exists')) throw e;
    console.log('[pg-daemon] Database "receptionist" already exists');
  }

  // Run migrations + seed synchronously
  console.log('[pg-daemon] Running migrations…');
  try {
    execSync('npx tsx src/db/migrate.ts', {
      cwd: BACKEND,
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://receptionist:receptionist_dev@localhost:5432/receptionist',
      },
    });
  } catch (e) {
    console.error('[pg-daemon] Migration failed:', e.message);
  }

  console.log('[pg-daemon] Running seed…');
  try {
    execSync('npx tsx src/db/seed.ts', {
      cwd: BACKEND,
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://receptionist:receptionist_dev@localhost:5432/receptionist',
      },
    });
  } catch (e) {
    console.error('[pg-daemon] Seed failed:', e.message);
  }

  console.log('[pg-daemon] ✅ Ready — PG stays alive. Kill this process to stop PG.');

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`[pg-daemon] Received ${signal} — stopping PG…`);
    try { await pg.stop(); } catch { /* ignore */ }
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep alive — heartbeat every 30s
  setInterval(() => {}, 30000);
}

main().catch((err) => {
  console.error('[pg-daemon] Fatal:', err.message);
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  process.exit(1);
});
