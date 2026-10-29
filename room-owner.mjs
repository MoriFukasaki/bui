import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
export const ownerHash = token => createHash('sha256').update(token).digest('hex');
export const newOwnerToken = () => randomBytes(32).toString('hex');
export function ownerCookie(req, code) {
  if (!/^[A-F0-9]{12}$/.test(code)) return '';
  return new RegExp(`(?:^|;\\s*)camroom_owner_${code}=([a-f0-9]{64})(?:;|$)`).exec(req.headers.cookie || '')?.[1] || '';
}
export function ownsRoom(req, room) {
  const token = ownerCookie(req, room.code);
  return Boolean(token && /^[a-f0-9]{64}$/.test(room.ownerHash || '') && timingSafeEqual(Buffer.from(ownerHash(token), 'hex'), Buffer.from(room.ownerHash, 'hex')));
}
export function setOwnerCookie(req, res, code, token) {
  res.setHeader('Set-Cookie', `camroom_owner_${code}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=2592000${process.env.NODE_ENV === 'production' || req.socket.encrypted ? '; Secure' : ''}`);
}
