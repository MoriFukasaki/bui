import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmin, hashPassword } from '../admin.mjs';
test('admin passwords are salted; secure session expires, rejects forged cookies and credential changes', async () => {
  const password = 'offline-test-password-only';
  const hash = await hashPassword(password); assert.notEqual(hash, await hashPassword(password));
  assert.ok(!hash.includes(password)); await assert.rejects(() => hashPassword('short'));
  let time = 1000; const env = { ADMIN_USERNAME: 'test-admin', ADMIN_PASSWORD_HASH: hash, NODE_ENV: 'production' };
  const admin = createAdmin({ env, now: () => time });
  const req = { socket: { remoteAddress: 'test' }, headers: {} }; let cookie;
  const res = { setHeader: (key, value) => { cookie = value; } };
  assert.equal((await admin.login(req, res, { username: 'test-admin', password: 'wrong' })).status, 401);
  const result = await admin.login(req, res, { username: 'test-admin', password }); assert.equal(result.status, 200);
  assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  req.headers.cookie = cookie.split(';')[0]; const session = admin.authenticated(req); assert.ok(session);
  assert.equal(admin.authorizedMutation(req, session), false);
  req.headers['x-csrf-token'] = result.csrf; assert.equal(admin.authorizedMutation(req, session), true);
  env.ADMIN_PASSWORD_HASH = await hashPassword('different-test-password'); assert.equal(admin.authenticated(req), null);
  env.ADMIN_PASSWORD_HASH = hash; time += 8 * 3600000; assert.equal(admin.authenticated(req), null);
  req.headers.cookie = `camroom_admin=${'0'.repeat(64)}`; assert.equal(admin.authenticated(req), null);
});
test('admin is disabled without config and login attempts are rate limited', async () => {
  const req = { socket: { remoteAddress: 'test' }, headers: {} }, res = { setHeader() {} };
  assert.equal((await createAdmin({ env: {} }).login(req, res, {})).status, 503);
  const admin = createAdmin({ env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: await hashPassword('offline-test-password') } });
  for (let i = 0; i < 10; i++) assert.equal((await admin.login(req, res, {})).status, 401);
  assert.equal((await admin.login(req, res, {})).status, 429);
});
