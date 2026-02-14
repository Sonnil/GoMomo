#!/usr/bin/env node
/**
 * local-start.mjs — Start the full AI Receptionist stack WITHOUT Docker.
 *
 * Launches:
 *   1. Embedded PostgreSQL 16 on port 5432
 *   2. Backend API on port 3000
 *   3. Frontend dev server on port 5173
 *
 * Usage:
 *   node local-start.mjs
 *
 * Prerequisites:
 *   - Node.js 20+
 *   - npm install (root, src/backend, src/frontend)
 *   - src/backend/.env with OPENAI_API_KEY set
 *
 * Press Ctrl+C to stop everything.
 */

import { createRequire } from 'module';
import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const BACKEND_DIR = path.join(__dirname, 'src', 'backend');
const FRONTEND_DIR = path.join(__dirname, 'src', 'frontend');
const PG_DATA = path.join(__dirname, '.pg-data');

const LOG_PREFIX = {
  pg: '\x1b[36m[postgres]\x1b[0m',
  be: '\x1b[33m[backend] \x1b[0m',
  fe: '\x1b[35m[frontend]\x1b[0m',
  sys: '\x1b[32m[launcher]\x1b[0m',
};

function log(prefix, msg) { console.log(`${prefix} ${msg}`); }
function logErr(prefix, msg) { console.error(`${prefix} \x1b[31m${msg}\x1b[0m`); }

// ── Pre-flight checks ──────────────────────────────────────
function preflightChecks() {
  // Check .env
  const envPath = path.join(BACKEND_DIR, '.env');
  if (!existsSync(envPath)) {
    logErr(LOG_PREFIX.sys, `Missing ${envPath}`);
    logErr(LOG_PREFIX.sys, 'Run: cp src/backend/.env.example src/backend/.env');
    logErr(LOG_PREFIX.sys, 'Then set OPENAI_API_KEY in that file.');
    process.exit(1);
  }

  const envContent = readFileSync(envPath, 'utf-8');
  if (envContent.includes('OPENAI_API_KEY=your-openai-api-key') ||
      !envContent.match(/OPENAI_API_KEY=\S+/)) {
    logErr(LOG_PREFIX.sys, 'OPENAI_API_KEY is not set in src/backend/.env');
    logErr(LOG_PREFIX.sys, 'Edit the file and paste your real OpenAI API key.');
    process.exit(1);
  }

  // Check node_modules
  if (!existsSync(path.join(BACKEND_DIR, 'node_modules'))) {
    log(LOG_PREFIX.sys, 'Installing backend dependencies…');
    execSync('npm install', { cwd: BACKEND_DIR, stdio: 'inherit' });
  }
  if (!existsSync(path.join(FRONTEND_DIR, 'node_modules'))) {
    log(LOG_PREFIX.sys, 'Installing frontend dependencies…');
    execSync('npm install', { cwd: FRONTEND_DIR, stdio: 'inherit' });
  }

  // Check embedded-postgres
  const epPath = path.join(__dirname, 'node_modules', 'embedded-postgres');
  if (!existsSync(epPath)) {
    log(LOG_PREFIX.sys, 'Installing embedded-postgres…');
    execSync('npm install embedded-postgres', { cwd: __dirname, stdio: 'inherit' });
  }
}

// ── Start Embedded Postgres ────────────────────────────────
async function startPostgres() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const pg = new EmbeddedPostgres({
    databaseDir: PG_DATA,
    user: 'receptionist',
    password: 'receptionist_dev',
    port: 5432,
    persistent: true,
  });

  log(LOG_PREFIX.pg, 'Starting embedded PostgreSQL…');

  // Only initialise if the data directory doesn't have a valid cluster yet
  const pgVersionFile = path.join(PG_DATA, 'PG_VERSION');
  if (!existsSync(pgVersionFile)) {
    log(LOG_PREFIX.pg, 'Initialising new data directory…');
    await pg.initialise();
  } else {
    log(LOG_PREFIX.pg, 'Existing data directory found — skipping initdb');
  }

  await pg.start();
  log(LOG_PREFIX.pg, 'PostgreSQL running on port 5432');

  // Create the database if it doesn't exist
  try {
    await pg.createDatabase('receptionist');
    log(LOG_PREFIX.pg, 'Database "receptionist" created');
  } catch (e) {
    // Database already exists — that's fine
    if (!String(e).includes('already exists')) {
      throw e;
    }
    log(LOG_PREFIX.pg, 'Database "receptionist" already exists');
  }

  return pg;
}

// ── Run Migrations + Seed ──────────────────────────────────
function runMigrationsAndSeed() {
  log(LOG_PREFIX.be, 'Running database migrations…');
  execSync('npx tsx src/db/migrate.ts', {
    cwd: BACKEND_DIR,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'postgresql://receptionist:receptionist_dev@localhost:5432/receptionist' },
  });

  log(LOG_PREFIX.be, 'Seeding demo data…');
  execSync('npx tsx src/db/seed.ts', {
    cwd: BACKEND_DIR,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'postgresql://receptionist:receptionist_dev@localhost:5432/receptionist' },
  });
}

// ── Start Backend ──────────────────────────────────────────
function startBackend() {
  log(LOG_PREFIX.be, 'Starting backend on port 3000…');
  const child = spawn('npx', ['tsx', 'watch', 'src/index.ts'], {
    cwd: BACKEND_DIR,
    stdio: 'pipe',
    env: { ...process.env, PATH: process.env.PATH },
  });

  child.stdout.on('data', (d) => {
    const line = d.toString().trim();
    if (line) log(LOG_PREFIX.be, line);
  });
  child.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line) log(LOG_PREFIX.be, line);
  });

  return child;
}

// ── Start Frontend ─────────────────────────────────────────
function startFrontend() {
  log(LOG_PREFIX.fe, 'Starting frontend on port 5173…');
  const child = spawn('npx', ['vite', '--host'], {
    cwd: FRONTEND_DIR,
    stdio: 'pipe',
    env: { ...process.env, PATH: process.env.PATH },
  });

  child.stdout.on('data', (d) => {
    const line = d.toString().trim();
    if (line) log(LOG_PREFIX.fe, line);
  });
  child.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line) log(LOG_PREFIX.fe, line);
  });

  return child;
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('\x1b[1m╔══════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[1m║  🌸 gomomo.ai — Local Launcher (no Docker)        ║\x1b[0m');
  console.log('\x1b[1m╚══════════════════════════════════════════════════╝\x1b[0m');
  console.log('');

  preflightChecks();

  // 1. Postgres
  let pg;
  try {
    pg = await startPostgres();
  } catch (err) {
    logErr(LOG_PREFIX.pg, `Failed to start: ${err?.message ?? err}`);
    process.exit(1);
  }

  // 2. Migrations + Seed
  try {
    runMigrationsAndSeed();
  } catch (err) {
    logErr(LOG_PREFIX.be, `Migrations/seed failed: ${err?.message ?? err}`);
    await pg.stop();
    process.exit(1);
  }

  // 3. Backend
  const backend = startBackend();

  // Wait a moment for backend to be ready
  await new Promise(r => setTimeout(r, 3000));

  // 4. Frontend
  const frontend = startFrontend();

  // Give frontend a moment to spin up
  await new Promise(r => setTimeout(r, 2000));

  console.log('');
  console.log('\x1b[1m\x1b[32m══════════════════════════════════════════════════\x1b[0m');
  console.log('\x1b[1m\x1b[32m  ✅  All services running!\x1b[0m');
  console.log('');
  console.log('  🌐  Chat widget:    \x1b[4mhttp://localhost:5173?demo=1\x1b[0m');
  console.log('  🔧  Backend API:    \x1b[4mhttp://localhost:3000\x1b[0m');
  console.log('  💚  Health check:   \x1b[4mhttp://localhost:3000/health\x1b[0m');
  console.log('  🐘  PostgreSQL:     localhost:5432');
  console.log('');
  console.log('  Press \x1b[1mCtrl+C\x1b[0m to stop everything.');
  console.log('\x1b[1m\x1b[32m══════════════════════════════════════════════════\x1b[0m');
  console.log('');

  // ── Graceful Shutdown ──────────────────────────────────
  const shutdown = async (signal) => {
    console.log(`\n${LOG_PREFIX.sys} Received ${signal} — shutting down…`);

    frontend.kill('SIGTERM');
    backend.kill('SIGTERM');

    // Give processes a moment to die
    await new Promise(r => setTimeout(r, 1000));

    try {
      await pg.stop();
      log(LOG_PREFIX.pg, 'Stopped');
    } catch { /* ignore */ }

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep alive
  backend.on('exit', (code) => {
    if (code !== null && code !== 0) {
      logErr(LOG_PREFIX.be, `Exited with code ${code}`);
    }
  });
  frontend.on('exit', (code) => {
    if (code !== null && code !== 0) {
      logErr(LOG_PREFIX.fe, `Exited with code ${code}`);
    }
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
