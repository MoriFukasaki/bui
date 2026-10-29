import './env.mjs';
import { createHmac } from 'node:crypto';

export function iceConfiguration(env = process.env, now = Date.now()) {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const urls = String(env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  const secret = env.TURN_SECRET, username = env.TURN_USERNAME, password = env.TURN_PASSWORD;
  if (urls.length) {
    if (urls.some(url => !/^turns?:[^\s@]+$/i.test(url))) throw Error('TURN_URLS phải gồm các URL turn: hoặc turns:, ngăn cách bằng dấu phẩy.');
    if (secret && (username || password)) throw Error('Chỉ chọn TURN_SECRET hoặc cặp TURN_USERNAME/TURN_PASSWORD.');
    if (secret) {
      const temporaryUser = `${Math.floor(now / 1000) + 86400}:camroom`;
      iceServers.push({ urls, username: temporaryUser, credential: createHmac('sha1', secret).update(temporaryUser).digest('base64') });
    } else if (username && password) iceServers.push({ urls, username, credential: password });
    else throw Error('Đã có TURN_URLS nhưng thiếu TURN_SECRET hoặc TURN_USERNAME + TURN_PASSWORD.');
  } else if (secret || username || password) throw Error('Thiếu TURN_URLS cho dịch vụ chuyển tiếp camera.');
  const policy = env.ICE_TRANSPORT_POLICY || 'all';
  if (!['all', 'relay'].includes(policy)) throw Error('ICE_TRANSPORT_POLICY chỉ nhận all hoặc relay.');
  if (policy === 'relay' && !urls.length) throw Error('Chế độ relay cần cấu hình TURN trước.');
  return { iceServers, iceTransportPolicy: policy, turnConfigured: Boolean(urls.length) };
}
