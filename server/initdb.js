// Idempotent schema migration. Runs on container start (see docker-compose command).
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = await readFile(join(__dirname, 'schema.sql'), 'utf8');
  // pgcrypto for gen_random_uuid()
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(sql);
  console.log('[initdb] schema applied');
  await pool.end();
}

main().catch((e) => {
  console.error('[initdb] failed:', e);
  process.exit(1);
});
