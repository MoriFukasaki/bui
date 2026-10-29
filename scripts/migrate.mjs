import '../env.mjs';
import { readFile } from 'node:fs/promises';
import { getPool } from '../database.mjs';
import { parseEnv } from 'node:util';
if (process.argv[2]) Object.assign(process.env, parseEnv(await readFile(process.argv[2], 'utf8')));
const pool = getPool(true);
try {
  const client = await pool.connect();
  try { await client.query('BEGIN'); await client.query(await readFile(new URL('../migrations/001_recordings.sql', import.meta.url), 'utf8')); await client.query('COMMIT'); console.log('PASS migration 001_recordings: table and index ready'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
} catch (error) { console.error(`Migration failed (${error.code || error.name}). No credentials logged.`); process.exitCode = 1; }
finally { await pool.end(); }
