import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RecordingStore, storageConfigured, downloadURL } from './recordings.mjs';
import { databaseEnabled, persistRecording, listRecordings, subscribeRecordings, closeDatabase, getPool } from './database.mjs';
import { iceConfiguration } from './ice.mjs';

const rooms = new Map(), sessions = new Map(), limits = new Map();
const publicDir = new URL('./public/', import.meta.url);
const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const info = p => ({ id: p.id, name: p.name, role: p.role, slot: p.slot, camera: p.camera || null });
const event = (p, type, data) => {
  if (!p.res || p.res.destroyed) return;
  // A false write return means data was buffered, not lost. Bound slow clients without disconnecting normal snapshots.
  if (p.res.writableLength > 1024 * 1024) { p.res.destroy(); return; }
  p.res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
};
const broadcast = (room, type, data) => { for (const p of room.peers.values()) event(p, type, data); };
const records = new RecordingStore({ onChange: async job => {
  await persistRecording(job);
  const room = rooms.get(job.room);
  if (room) { room.recordings.set(job.id, job); broadcast(room, 'recording-status', job); }
} });
const roomState = room => ({ hostId: room.hostId, take: room.take, recordings: [...room.recordings.values()], storage: Boolean(storageConfigured()) });
function remove(p) {
  if (!sessions.has(p.token)) return;
  sessions.delete(p.token); p.room.peers.delete(p.id); p.res?.end();
  broadcast(p.room, 'left', { id: p.id });
  if (p.room.hostId === p.id) { p.room.hostId = p.room.peers.values().next().value?.id; broadcast(p.room, 'host', { id: p.room.hostId }); }
  if (p.room.live === p.id) { p.room.live = null; broadcast(p.room, 'live', { id: null }); }
  if (!p.room.peers.size) { p.room.closeRealtime?.(); rooms.delete(p.room.code); }
}
async function body(req) {
  let data = ''; for await (const part of req) { data += part; if (data.length > 65536) throw Error('Dữ liệu quá lớn.'); }
  return JSON.parse(data || '{}');
}
export const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return send(res, 403, { error: 'Origin không hợp lệ.' });
    if (req.method === 'GET' && ['/', '/app.js', '/style.css', '/recorder.js', '/mesh.js'].includes(url.pathname)) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const data = await readFile(new URL(name, publicDir));
      res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' }); return res.end(data);
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const ice = iceConfiguration();
      const ip = req.socket.remoteAddress, now = Date.now();
      const limit = limits.get(ip) || { start: now, count: 0 }; if (now - limit.start > 60000) { limit.start = now; limit.count = 0; }
      limits.set(ip, limit); if (++limit.count > 60) return send(res, 429, { error: 'Thử lại sau một phút.' });
      const input = await body(req); const role = input.role === 'camera' ? 'camera' : 'viewer';
      let room;
      if (input.create) {
        if (rooms.size >= 200) return send(res, 503, { error: 'Máy chủ đang đầy.' });
        const maxCameras = Number(input.maxCameras ?? 3);
        if (!Number.isInteger(maxCameras) || maxCameras < 1 || maxCameras > 10) return send(res, 400, { error: 'Số camera phải từ 1 đến 10.' });
        const code = randomBytes(6).toString('hex').toUpperCase();
        room = { code, peers: new Map(), live: null, maxCameras, hostId: null, take: null, recordings: new Map() }; rooms.set(code, room);
      } else room = rooms.get(String(input.code || '').toUpperCase());
      if (!room) return send(res, 404, { error: 'Không tìm thấy phòng. Kiểm tra mã hoặc tạo phòng mới.' });
      const used = [...room.peers.values()].filter(p => p.role === 'camera').map(p => p.slot);
      if (room.peers.size >= 10) return send(res, 409, { error: 'Phòng đã đủ 10 thiết bị (gồm cả máy chỉ xem).' });
      if (role === 'camera' && used.length >= room.maxCameras) return send(res, 409, { error: `Phòng đã đủ ${room.maxCameras} camera. Chọn “Chỉ xem” để tham gia.` });
      const token = randomBytes(24).toString('hex');
      const p = { id: randomBytes(8).toString('hex'), token, name: String(input.name || (role === 'camera' ? 'Camera' : 'Đạo diễn')).trim().slice(0, 30), role, slot: role === 'camera' ? Array.from({ length: room.maxCameras }, (_, i) => i + 1).find(x => !used.includes(x)) : null, room, created: Date.now(), res: null };
      room.peers.set(p.id, p); sessions.set(token, p);
      if (!room.hostId) room.hostId = p.id;
      if (databaseEnabled() && !room.realtimeStarting) {
        room.realtimeStarting = true;
        subscribeRecordings(room.code, items => broadcast(room, 'neon-recordings', items), state => {
          room.cloudStatus = state.status; broadcast(room, 'cloud-status', { status: state.status });
        }).then(close => { if (rooms.has(room.code)) room.closeRealtime = close; else close(); }).catch(() => broadcast(room, 'cloud-status', { status: 'error' }));
      }
      return send(res, 200, { ...info(p), token, code: room.code, maxCameras: room.maxCameras, ...ice, ...roomState(room) });
    }
    // Upload capabilities are separate from room sessions, so a stopped recording can finish after leaving/restarting.
    const uploadRoute = /^\/api\/uploads\/([a-f0-9]{32})\/(chunk|complete|status)$/.exec(url.pathname);
    if (uploadRoute) {
      const [, id, action] = uploadRoute, token = (req.headers.authorization || '').replace(/^Bearer /, '');
      await records.authenticated(id, token);
      if (action === 'status' && req.method === 'GET') { const job = await records.load(id); return send(res, 200, { ...records.public(job), next: job.chunks.length }); }
      if (action === 'chunk' && req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw Error('Chunk quá lớn.'); chunks.push(chunk); }
        if (!size) return send(res, 400, { error: 'Chunk rỗng.' });
        return send(res, 200, await records.chunk(id, token, Number(url.searchParams.get('index')), Buffer.concat(chunks)));
      }
      if (action === 'complete' && req.method === 'POST') {
        const details = await body(req);
        try { return send(res, 200, await records.complete(id, token, details)); }
        catch (error) { return send(res, 503, { error: error.message }); }
      }
      return send(res, 405, { error: 'Phương thức không hợp lệ.' });
    }
    const p = sessions.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!p) return send(res, 401, { error: 'Phiên đã hết. Vui lòng vào lại phòng.' });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (p.res) return send(res, 409, { error: 'Phiên đã kết nối.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      p.res = res;
      event(p, 'welcome', { peers: [...p.room.peers.values()].filter(x => x.id !== p.id && x.res).map(info), live: p.room.live, ...roomState(p.room) });
      for (const other of p.room.peers.values()) if (other.id !== p.id) event(other, 'joined', info(p));
      res.on('close', () => remove(p)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/leave') { remove(p); return send(res, 200, {}); }
    if (req.method === 'POST' && url.pathname === '/api/time') return send(res, 200, { now: Date.now() });
    if (req.method === 'POST' && url.pathname === '/api/recordings') return send(res, 200, { recordings: databaseEnabled() ? await listRecordings(p.room.code) : [...p.room.recordings.values()] });
    if (req.method === 'POST' && url.pathname === '/api/record/download') {
      const { id } = await body(req);
      const job = p.room.recordings.get(id) || (await listRecordings(p.room.code)).find(job => job.id === id);
      if (!job || job.state !== 'uploaded') return send(res, 404, { error: 'Video chưa có trong phòng này.' });
      return send(res, 200, { url: await downloadURL(job) });
    }
    if (req.method === 'POST' && url.pathname === '/api/camera-state') {
      if (p.role !== 'camera') return send(res, 403, { error: 'Chỉ máy camera được cập nhật.' });
      const input = await body(req);
      p.camera = { ready: Boolean(input.ready), settings: input.settings || {}, capabilities: input.capabilities || {}, mime: String(input.mime || ''), error: String(input.error || '').slice(0, 200) };
      broadcast(p.room, 'camera-state', info(p)); return send(res, 200, {});
    }
    if (req.method === 'POST' && url.pathname === '/api/camera-config') {
      const input = await body(req), target = p.room.peers.get(input.id);
      if (p.id !== p.room.hostId && p.id !== input.id) return send(res, 403, { error: 'Chỉ chủ phòng được chỉnh camera khác.' });
      if (p.room.take?.active) return send(res, 409, { error: 'Dừng lượt quay trước khi đổi cấu hình.' });
      if (!target || target.role !== 'camera' || !target.res) return send(res, 404, { error: 'Camera chưa kết nối.' });
      target.camera = { ...target.camera, ready: false };
      broadcast(p.room, 'camera-state', info(target)); event(target, 'camera-config', input.config || {}); return send(res, 200, {});
    }
    if (req.method === 'POST' && url.pathname === '/api/record/start') {
      if (p.id !== p.room.hostId) return send(res, 403, { error: 'Chỉ chủ phòng được bắt đầu quay chung.' });
      if (!storageConfigured()) return send(res, 503, { error: 'Chưa cấu hình Neon bucket trên server. Xem README.' });
      if (p.room.take?.active) return send(res, 409, { error: 'Phòng đang có lượt quay.' });
      const cameras = [...p.room.peers.values()].filter(x => x.role === 'camera');
      if (!cameras.length || cameras.some(x => !x.res || !x.camera?.ready)) return send(res, 409, { error: 'Tất cả camera phải báo Sẵn sàng trước khi quay.' });
      if (p.room.recordings.size >= 1000) return send(res, 409, { error: 'Tạo phòng mới để tiếp tục quay.' });
      const take = { id: randomBytes(8).toString('hex'), scheduledAt: Date.now() + 3000, active: true, preparing: true, cameraIds: cameras.map(x => x.id) };
      // Reserve immediately to prevent two simultaneous starts while disk writes are pending.
      p.room.take = take;
      try {
        const jobs = [];
        for (const camera of cameras) jobs.push([camera, await records.create({ room: p.room.code, take: take.id, peerId: camera.id, slot: camera.slot, name: camera.name, scheduledAt: take.scheduledAt, settings: camera.camera.settings })]);
        take.scheduledAt = Date.now() + 3000;
        await Promise.all(jobs.map(async ([, job]) => { await records.update(job.id, { scheduledAt: take.scheduledAt }); job.scheduledAt = take.scheduledAt; }));
        take.preparing = false;
        for (const [camera, job] of jobs) {
          const { token, ...safe } = job; p.room.recordings.set(job.id, safe); event(camera, 'record-start', job);
        }
        broadcast(p.room, 'take', { ...take, recordings: [...p.room.recordings.values()] }); return send(res, 200, take);
      } catch { p.room.take = null; throw Error('Không tạo được lượt quay.'); }
    }
    if (req.method === 'POST' && url.pathname === '/api/record/stop') {
      if (p.id !== p.room.hostId) return send(res, 403, { error: 'Chỉ chủ phòng được dừng quay chung.' });
      const take = p.room.take;
      if (!take?.active) return send(res, 409, { error: 'Không có lượt đang quay.' });
      if (take.preparing) return send(res, 409, { error: 'Đang chuẩn bị lượt quay. Hãy đợi thông báo đếm ngược.' });
      take.active = false; take.stopAt = Date.now() + 500;
      broadcast(p.room, 'record-stop', take); broadcast(p.room, 'take', take); return send(res, 200, take);
    }
    if (req.method === 'POST' && url.pathname === '/api/record/ack') {
      const input = await body(req), job = await records.load(input.id);
      if (job.peerId !== p.id || job.room !== p.room.code) return send(res, 403, { error: 'Không có quyền cập nhật video.' });
      if (!['recording', 'failed', 'stopped'].includes(input.state)) return send(res, 400, { error: 'Trạng thái không hợp lệ.' });
      await records.update(job.id, { captureState: input.state, captureError: String(input.error || '').slice(0, 200), actualStartedAt: input.actualStartedAt });
      return send(res, 200, {});
    }
    if (req.method === 'POST' && url.pathname === '/api/live') {
      const { id } = await body(req); const target = p.room.peers.get(id);
      if (id !== null && (!target || target.role !== 'camera')) return send(res, 400, { error: 'Camera không tồn tại.' });
      p.room.live = id; broadcast(p.room, 'live', { id }); return send(res, 200, {});
    }
    if (req.method === 'POST' && url.pathname === '/api/signal') {
      const { to, sender, description, candidate, connectionId, restart, relay } = await body(req);
      const target = p.room.peers.get(to);
      if (!target) return send(res, 404, { error: 'Thiết bị đã rời phòng.' });
      if (sender !== p.id && sender !== to) return send(res, 400, { error: 'Tín hiệu không hợp lệ.' });
      if (connectionId !== undefined && (typeof connectionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(connectionId))) return send(res, 400, { error: 'Phiên kết nối camera không hợp lệ.' });
      if (restart && (sender !== to || target.role !== 'camera')) return send(res, 400, { error: 'Yêu cầu kết nối lại không hợp lệ.' });
      event(target, 'signal', { from: p.id, sender, description, candidate, connectionId, restart: Boolean(restart), relay: Boolean(relay) }); return send(res, 200, {});
    }
    send(res, 404, { error: 'Không tìm thấy.' });
  } catch { if (!res.headersSent) send(res, 400, { error: 'Yêu cầu không hợp lệ.' }); else res.end(); }
});
const housekeeping = setInterval(() => {
  for (const p of sessions.values()) { if (p.res) event(p, 'ping', {}); else if (Date.now() - p.created > 30000) remove(p); }
  for (const [ip, limit] of limits) if (Date.now() - limit.start > 60000) limits.delete(ip);
}, 15000);
housekeeping.unref();
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ice = iceConfiguration();
  console.log(ice.turnConfigured ? `Camera relay: configured (${ice.iceTransportPolicy})` : 'Camera relay: not configured; different networks may need TURN');
  if (databaseEnabled()) { await getPool().query('SELECT id FROM camroom_recordings LIMIT 0'); console.log('Postgres: connected; recording schema ready'); }
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`Camroom: http://localhost:${process.env.PORT || 3000}`));
  const shutdown = () => { server.closeAllConnections(); server.close(); closeDatabase().finally(() => process.exit()); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
