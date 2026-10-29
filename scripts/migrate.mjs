import '../env.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { getPool, databaseEnabled } from '../database.mjs';
import { parseEnv } from 'node:util';
if (process.argv[2]) Object.assign(process.env, parseEnv(await readFile(process.argv[2], 'utf8')));
if (!databaseEnabled()) { console.log('Postgres: migration skipped (not configured/offline).'); process.exit(0); }
const pool = getPool(true);
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      await client.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      console.log(`PASS migration ${name}`);
    }
    await client.query('COMMIT');
  }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
} catch (error) { console.error(`Migration failed (${error.code || error.name}). No credentials logged.`); process.exitCode = 1; }
finally { await pool.end(); }
