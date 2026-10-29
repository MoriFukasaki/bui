import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RecordingStore, storageConfigured, openRecording } from './recordings.mjs';
import { databaseEnabled, persistRecording, listRecordings, saveRoom, loadRoom, deleteRecordingRow, subscribeRecordings, closeDatabase, getPool } from './database.mjs';
import { iceConfiguration } from './ice.mjs';
import { pipeline } from 'node:stream/promises';
import { ownerHash, newOwnerToken, ownsRoom, setOwnerCookie } from './room-owner.mjs';

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
export const records = new RecordingStore({ onChange: async job => {
  await persistRecording(job);
  const room = rooms.get(job.room);
  if (room && job.state === 'deleted') { room.recordings.delete(job.id); broadcast(room, 'recordings-deleted', { ids: [job.id] }); }
  if (room && job.state !== 'deleted' && job.take === room.latestTake) { room.recordings.set(job.id, job); broadcast(room, 'recording-status', job); }
}, onDelete: async job => {
  await deleteRecordingRow(job.id, job.room);
  const room = rooms.get(job.room); if (room) {
    room.recordings.delete(job.id); broadcast(room, 'recordings-deleted', { ids: [job.id] });
    if (room.take?.id === job.take && !room.take.active) {
      room.take.cameraIds = room.take.cameraIds.filter(id => id !== job.peerId); broadcast(room, 'take', room.take);
    }
  }
} });
function makeRoom(meta) { return { ...meta, peers: new Map(), recordings: new Map(), live: null, hostId: null, take: null, transitioning: false, touchedAt: Date.now() }; }
const loadingRooms = new Map();
async function getRoom(code) {
  if (!/^[A-F0-9]{12}$/.test(code)) return null;
  if (rooms.has(code)) return rooms.get(code);
  if (!loadingRooms.has(code)) loadingRooms.set(code, (async () => {
    const meta = await loadRoom(code); if (!meta) return null;
    const room = makeRoom(meta), jobs = await listRecordings(code);
    for (const job of jobs) if (job.take === room.latestTake) room.recordings.set(job.id, job);
    if (room.latestTake) room.take = { id: room.latestTake, active: false, cameraIds: [...new Set([...room.recordings.values()].map(job => job.peerId))] };
    rooms.set(code, room); return room;
  })());
  try { return await loadingRooms.get(code); } finally { loadingRooms.delete(code); }
}
async function roomJobs(room) {
  return [...new Map([...(await listRecordings(room.code, true)), ...room.recordings.values(), ...(await records.listRoom(room.code))].map(job => [job.id, job])).values()];
}
async function purgeRoom(room) {
  const jobs = await roomJobs(room);
  for (const job of jobs) await records.delete(job);
  room.recordings.clear();
}

const roomState = room => ({ hostId: room.hostId, take: room.take, recordings: [...room.recordings.values()].filter(job => job.take === room.latestTake && job.state !== 'deleted'), latestTake: room.latestTake, storage: Boolean(storageConfigured()) });
function remove(p) {
  if (!sessions.has(p.token)) return;
  sessions.delete(p.token); p.room.peers.delete(p.id); p.res?.end();
  broadcast(p.room, 'left', { id: p.id });
  if (p.room.hostId === p.id) { p.room.hostId = null; broadcast(p.room, 'host', { id: null }); }
  if (p.room.live === p.id) { p.room.live = null; broadcast(p.room, 'live', { id: null }); }
  p.room.touchedAt = Date.now();
  if (!p.room.peers.size) { p.room.closeRealtime?.(); p.room.closeRealtime = null; p.room.realtimeStarting = false; }
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
    if (req.method === 'GET' && ['/', '/app.js', '/style.css', '/recorder.js', '/recording-storage.js', '/mesh.js'].includes(url.pathname)) {
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
      let room, creatorToken;
      if (input.create) {
        for (const [code, cached] of rooms) if (!cached.peers.size) rooms.delete(code);
        if (rooms.size >= 200) return send(res, 503, { error: 'Máy chủ đang đầy.' });
        const maxCameras = Number(input.maxCameras ?? 3);
        if (!Number.isInteger(maxCameras) || maxCameras < 1 || maxCameras > 10) return send(res, 400, { error: 'Số camera phải từ 1 đến 10.' });
        const code = randomBytes(6).toString('hex').toUpperCase();
        creatorToken = newOwnerToken();
        room = makeRoom({ code, maxCameras, ownerHash: ownerHash(creatorToken), latestTake: null });
        await saveRoom(room); rooms.set(code, room); setOwnerCookie(req, res, code, creatorToken);
      } else room = await getRoom(String(input.code || '').toUpperCase());
      if (room && !input.create && !room.peers.size && !ownsRoom(req, room)) room = null;
      if (!room) return send(res, 404, { error: 'Không tìm thấy phòng. Kiểm tra mã hoặc tạo phòng mới.' });
      const used = [...room.peers.values()].filter(p => p.role === 'camera').map(p => p.slot);
      if (room.peers.size >= 10) return send(res, 409, { error: 'Phòng đã đủ 10 thiết bị (gồm cả máy chỉ xem).' });
      if (role === 'camera' && used.length >= room.maxCameras) return send(res, 409, { error: `Phòng đã đủ ${room.maxCameras} camera. Chọn “Chỉ xem” để tham gia.` });
      const token = randomBytes(24).toString('hex');
      const p = { id: randomBytes(8).toString('hex'), token, name: String(input.name || (role === 'camera' ? 'Camera' : 'Đạo diễn')).trim().slice(0, 30), role, slot: role === 'camera' ? Array.from({ length: room.maxCameras }, (_, i) => i + 1).find(x => !used.includes(x)) : null, room, created: Date.now(), res: null };
      room.peers.set(p.id, p); sessions.set(token, p);
      if (creatorToken || ownsRoom(req, room)) { room.hostId = p.id; broadcast(room, 'host', { id: p.id }); }
      room.touchedAt = Date.now();
      if (databaseEnabled() && !room.realtimeStarting) {
        room.realtimeStarting = true;
        subscribeRecordings(room.code, items => broadcast(room, 'neon-recordings', items.filter(job => job.take === room.latestTake && job.state !== 'deleted' && room.recordings.has(job.id))), state => {
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
        catch (error) { return send(res, error.code === 'RECORDING_GONE' ? 410 : 503, { error: error.message }); }
      }
      return send(res, 405, { error: 'Phương thức không hợp lệ.' });
    }
    const fileRoute = /^\/api\/rooms\/([A-F0-9]{12})\/videos\/([a-f0-9]{32})$/.exec(url.pathname);
    if (req.method === 'GET' && fileRoute) {
      const [, code, id] = fileRoute, room = await getRoom(code);
      if (!room || !ownsRoom(req, room)) return send(res, 403, { error: 'Chỉ admin của phòng được tải video.' });
      const job = room.recordings.get(id);
      if (room.transitioning || !job || job.take !== room.latestTake || job.state !== 'uploaded') return send(res, 404, { error: 'Video đã bị xóa hoặc chưa lưu xong.' });
      const object = await openRecording(job);
      try {
        res.writeHead(200, { 'Content-Type': job.mime?.startsWith('video/mp4') ? 'video/mp4' : 'video/webm', 'Content-Length': object.size,
          'Content-Disposition': `attachment; filename="cam-${job.slot}-${job.id}.${job.mime?.startsWith('video/mp4') ? 'mp4' : 'webm'}"` });
        await pipeline(object.body, res); return;
      } finally { object.close(); }
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
    if (req.method === 'POST' && url.pathname === '/api/recordings') return send(res, 200, { recordings: [...p.room.recordings.values()].filter(job => job.take === p.room.latestTake && job.state !== 'deleted') });
    if (req.method === 'POST' && url.pathname === '/api/record/download') {
      if (p.id !== p.room.hostId) return send(res, 403, { error: 'Chỉ admin của phòng được tải video.' });
      if (p.room.transitioning) return send(res, 409, { error: 'Đang thay lượt quay.' });
      const { id } = await body(req);
      const job = p.room.recordings.get(id);
      if (!job || job.state !== 'uploaded') return send(res, 404, { error: 'Video chưa có trong phòng này.' });
      return send(res, 200, { url: `/api/rooms/${p.room.code}/videos/${job.id}` });
    }
    if (req.method === 'POST' && url.pathname === '/api/record/delete') {
      if (p.id !== p.room.hostId) return send(res, 403, { error: 'Chỉ admin của phòng được xóa video.' });
      if (p.room.take?.active || p.room.transitioning) return send(res, 409, { error: 'Đợi dừng quay và xử lý lượt quay trước khi xóa.' });
      const { id } = await body(req), job = (await roomJobs(p.room)).find(job => job.id === id);
      if (!job) return send(res, 404, { error: 'Video không thuộc phòng này.' });
      p.room.transitioning = true;
      try { await records.delete(job); return send(res, 200, {}); }
      catch { return send(res, 503, { error: 'Chưa xóa hết video. Kiểm tra Neon/mạng rồi thử lại.' }); }
      finally { p.room.transitioning = false; }
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
      if (p.room.take?.active || p.room.transitioning) return send(res, 409, { error: 'Phòng đang quay hoặc đang thay lượt quay.' });
      const cameras = [...p.room.peers.values()].filter(x => x.role === 'camera');
      if (!cameras.length || cameras.some(x => !x.res || !x.camera?.ready)) return send(res, 409, { error: 'Tất cả camera phải báo Sẵn sàng trước khi quay.' });
      const take = { id: randomBytes(8).toString('hex'), scheduledAt: Date.now() + 3000, active: true, preparing: true, cameraIds: cameras.map(x => x.id) };
      // Reserve immediately to prevent two simultaneous starts while disk writes are pending.
      const previousTake = p.room.take; p.room.take = take; p.room.transitioning = true;
      broadcast(p.room, 'take', take);
      try {
        await purgeRoom(p.room);
        if (p.room.hostId !== p.id || cameras.some(camera => !p.room.peers.has(camera.id) || !camera.res || !camera.camera?.ready)) throw Error('Thiết bị đã rời phòng trong khi chuẩn bị.');
        p.room.latestTake = take.id; await saveRoom(p.room);
        broadcast(p.room, 'recordings-reset', { room: p.room.code, take: take.id });
        const jobs = [];
        for (const camera of cameras) jobs.push([camera, await records.create({ room: p.room.code, take: take.id, peerId: camera.id, slot: camera.slot, name: camera.name, scheduledAt: take.scheduledAt, settings: camera.camera.settings })]);
        take.scheduledAt = Date.now() + 3000;
        await Promise.all(jobs.map(async ([, job]) => { await records.update(job.id, { scheduledAt: take.scheduledAt }); job.scheduledAt = take.scheduledAt; }));
        take.preparing = false;
        for (const [camera, job] of jobs) {
          const { token, ...safe } = job; p.room.recordings.set(job.id, safe); event(camera, 'record-start', job);
        }
        broadcast(p.room, 'take', { ...take, recordings: [...p.room.recordings.values()] }); return send(res, 200, take);
      } catch { p.room.take = previousTake?.id === p.room.latestTake ? previousTake : null; broadcast(p.room, 'take', p.room.take); return send(res, 503, { error: 'Chưa xóa hết lượt cũ hoặc chưa tạo được lượt mới. Chưa bắt đầu ghi; kiểm tra Neon/mạng rồi thử lại.' }); }
      finally { p.room.transitioning = false; }
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
      const patch = { captureState: input.state, captureError: String(input.error || '').slice(0, 200) };
      if (Number.isFinite(input.actualStartedAt)) patch.actualStartedAt = input.actualStartedAt;
      if (input.capture) patch.capture = records.captureDetails(input.capture);
      await records.update(job.id, patch);
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
  } catch (error) { if (!res.headersSent) send(res, error.code === 'RECORDING_GONE' ? 410 : 400, { error: error.code === 'RECORDING_GONE' ? error.message : 'Yêu cầu không hợp lệ.' }); else res.destroy(); }
});
const housekeeping = setInterval(() => {
  for (const p of sessions.values()) { if (p.res) event(p, 'ping', {}); else if (Date.now() - p.created > 30000) remove(p); }
  for (const [code, room] of rooms) if (!room.peers.size && Date.now() - room.touchedAt > 3600000) rooms.delete(code);
  for (const [ip, limit] of limits) if (Date.now() - limit.start > 60000) limits.delete(ip);
}, 15000);
housekeeping.unref();
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ice = iceConfiguration();
  console.log(ice.turnConfigured ? `Camera relay: configured (${ice.iceTransportPolicy})` : 'Camera relay: not configured; different networks may need TURN');
  if (databaseEnabled()) { await getPool().query('SELECT code FROM camroom_rooms LIMIT 0'); console.log('Postgres: connected; recording schema ready'); }
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`Camroom: http://localhost:${process.env.PORT || 3000}`));
  const shutdown = () => { server.closeAllConnections(); server.close(); closeDatabase().finally(() => process.exit()); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
