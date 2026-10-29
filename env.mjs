import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
// Keep injected deployment variables authoritative; load CLI-managed local files only on the server.
if (!process.env.CAMROOM_OFFLINE) {
  const injected = { ...process.env };
  for (const file of ['.env', '.env.local']) if (existsSync(file)) Object.assign(process.env, parseEnv(readFileSync(file, 'utf8')));
  Object.assign(process.env, injected);
}
process.env.NEON_BUCKET ||= 'assets';
