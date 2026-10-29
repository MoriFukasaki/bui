import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { extname } from 'node:path';

// Print file names and rule names only. Never echo a matched secret or source line.
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const names = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))];
const staged = new Set(git(['ls-files', '--cached', '-z']).split('\0').filter(Boolean));
const sensitivePath = /(^|\/)(\.env(?:\..+)?|\.neon|data|node_modules|dist|verification)(\/|$)|\.(?:zip|mp4|webm|mov|pem|key|log)$/i;
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Postgres credentials', /postgres(?:ql)?:\/\/[^\s/:]+:[^\s@]+@/i],
  ['Neon secret', /\bnsk_(?:live|test)_[a-zA-Z0-9_-]{12,}/],
  ['GitHub token', /\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,})/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
];
const localSecrets = [];
for (const path of ['.env', '.env.local']) {
  if (!existsSync(path)) continue;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (value.length >= 8 && /SECRET|TOKEN|PASSWORD|DATABASE_URL|ACCESS_KEY/i.test(key)) localSecrets.push(value);
    if (/^DATABASE_URL/.test(key) && value) { try { const password = decodeURIComponent(new URL(value).password); if (password.length >= 8) localSecrets.push(password); } catch {} }
  }
}
let failures = 0;
for (const name of names) {
  if (name === '.env.example') {
    // Only documented non-secret example defaults may have values in a template.
    for (const [key, value] of Object.entries(parseEnv(readFileSync(name, 'utf8')))) {
      if (/SECRET|TOKEN|PASSWORD|DATABASE_URL|ACCESS_KEY/i.test(key) && value) { console.error(`FAIL ${name}: non-empty credential field ${key}`); failures++; }
    }
  } else if (sensitivePath.test(name.replaceAll('\\', '/'))) { console.error(`FAIL ${name}: private/generated path would be published`); failures++; }
  const content = existsSync(name) ? readFileSync(name) : Buffer.alloc(0);
  if (content.includes(0)) { console.error(`FAIL ${name}: binary file requires explicit review`); failures++; continue; }
  const text = content.toString('utf8');
  for (const [label, regex] of rules) if (regex.test(text)) { console.error(`FAIL ${name}: ${label}`); failures++; }
  if (localSecrets.some(secret => text.includes(secret))) { console.error(`FAIL ${name}: contains a local credential value`); failures++; }
  if (staged.has(name)) {
    const indexed = git(['show', `:${name}`]);
    for (const [label, regex] of rules) if (regex.test(indexed)) { console.error(`FAIL ${name} [index]: ${label}`); failures++; }
    if (localSecrets.some(secret => indexed.includes(secret))) { console.error(`FAIL ${name} [index]: contains a local credential value`); failures++; }
    if (name === '.env.example') for (const [key, value] of Object.entries(parseEnv(indexed))) {
      if (/SECRET|TOKEN|PASSWORD|DATABASE_URL|ACCESS_KEY/i.test(key) && value) { console.error(`FAIL ${name} [index]: non-empty credential field ${key}`); failures++; }
    }
  }
  if (extname(name) === '.map') { console.error(`FAIL ${name}: generated source map requires review`); failures++; }
}
for (const path of ['.env.local', '.neon', 'data/recordings/sample/manifest.json', 'dist/server.mjs', 'verification/sample.mp4', 'camroom.zip']) {
  try { git(['check-ignore', '--no-index', '--quiet', path]); }
  catch { console.error(`FAIL ignore rule missing: ${path}`); failures++; }
}
if (failures) { console.error(`PUBLISH CHECK FAILED: ${failures} issue(s); matched values were withheld.`); process.exitCode = 1; }
else console.log(`PUBLISH CHECK PASS: ${names.length} Git candidate files scanned; no known secret patterns or local credential values; runtime data and env files excluded.`);
