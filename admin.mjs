import './env.mjs';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt), digest = value => createHash('sha256').update(value).digest();
const equal = (a, b) => timingSafeEqual(digest(a), digest(b));
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw Error('Mật khẩu phải dài 12–256 ký tự.');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export function createAdmin({ env = process.env, now = () => Date.now() } = {}) {
  const sessions = new Map(), attempts = new Map();
  const configured = () => Boolean(env.ADMIN_USERNAME && /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(env.ADMIN_PASSWORD_HASH || ''));
  const secure = req => env.NODE_ENV === 'production' || Boolean(req.socket.encrypted);
  const cookie = (req, value, age) => `camroom_admin=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${age}${secure(req) ? '; Secure' : ''}`;
  function authenticated(req) {
    const token = /(?:^|;\s*)camroom_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const session = token && sessions.get(token);
    if (!configured() || !session || session.expires <= now() || session.fingerprint !== digest(`${env.ADMIN_USERNAME}:${env.ADMIN_PASSWORD_HASH}`).toString('hex')) return null;
    return { token, ...session };
  }
  async function login(req, res, input) {
    if (!configured()) return { status: 503, error: 'Chưa cấu hình tài khoản admin trên server. Xem ADMIN.md.' };
    // Deliberately use the socket address, not a client-supplied forwarding header.
    const ip = req.socket.remoteAddress || 'unknown', time = now();
    for (const [key, attempt] of attempts) if (attempt.until <= time) attempts.delete(key);
    if (!attempts.has(ip) && attempts.size >= 1000) return { status: 429, error: 'Máy chủ đang giới hạn đăng nhập. Thử lại sau.' };
    const attempt = attempts.get(ip) || { count: 0, until: time + 15 * 60000 };
    if (attempt.count >= 10) return { status: 429, error: 'Đăng nhập quá nhiều lần. Thử lại sau 15 phút.' };
    attempt.count++; attempts.set(ip, attempt);
    const password = typeof input.password === 'string' ? input.password : '';
    if (password.length > 256) return { status: 401, error: 'Sai tài khoản hoặc mật khẩu.' };
    const [, salt, expected] = env.ADMIN_PASSWORD_HASH.split(':');
    const actual = await derive(password, salt, 64, { N: 16384, r: 8, p: 1 });
    if (!equal(String(input.username || ''), env.ADMIN_USERNAME) || !timingSafeEqual(actual, Buffer.from(expected, 'hex'))) return { status: 401, error: 'Sai tài khoản hoặc mật khẩu.' };
    for (const [key, session] of sessions) if (session.expires <= time) sessions.delete(key);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
    const old = authenticated(req); if (old) sessions.delete(old.token);
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
    sessions.set(token, { csrf, expires: time + 8 * 3600000, fingerprint: digest(`${env.ADMIN_USERNAME}:${env.ADMIN_PASSWORD_HASH}`).toString('hex') });
    res.setHeader('Set-Cookie', cookie(req, token, 8 * 3600));
    return { status: 200, username: env.ADMIN_USERNAME, csrf };
  }
  function authorizedMutation(req, session) { return Boolean(session && equal(req.headers['x-csrf-token'] || '', session.csrf)); }
  function logout(req, res, session) { sessions.delete(session.token); res.setHeader('Set-Cookie', cookie(req, '', 0)); }
  return { configured, authenticated, login, authorizedMutation, logout };
}
