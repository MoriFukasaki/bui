import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CAMROOM_OFFLINE = '1';
const { server } = await import('../server.mjs');
let base;
before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
async function post(path, body, session) {
  const response = await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function join(body) { const r = await post('join', { role: 'camera', name: 'Test', ...body }); assert.equal(r.status, 200); return r.body; }
async function leave(...sessions) { for (const s of sessions) await post('leave', {}, s); }
async function events(session) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${session.token}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  return { close: () => controller.abort(), next: async () => {
    while (!buffer.includes('\n\n')) { const { value, done } = await reader.read(); assert.equal(done, false); buffer += decoder.decode(value, { stream: true }); }
    const i = buffer.indexOf('\n\n'), frame = buffer.slice(0, i); buffer = buffer.slice(i + 2); return JSON.parse(frame.slice(6));
  } };
}
test('room setting caps cameras, preserves viewer access and reuses freed slots', async () => {
  const first = await join({ create: true, maxCameras: 2 });
  const second = await join({ code: first.code });
  assert.equal(first.maxCameras, 2); assert.equal(second.slot, 2);
  assert.equal((await post('join', { code: first.code, role: 'camera' })).status, 409);
  const viewer = await join({ code: first.code, role: 'viewer' }); assert.equal(viewer.slot, null);
  await leave(second); const replacement = await join({ code: first.code }); assert.equal(replacement.slot, 2);
  await leave(first, viewer, replacement);
  assert.equal((await post('join', { code: first.code })).status, 404);
});
test('ten devices total including viewers, ten camera slots supported', async () => {
  const first = await join({ create: true, maxCameras: 10 }); const all = [first];
  for (let i = 1; i < 10; i++) all.push(await join({ code: first.code }));
  assert.deepEqual(all.map(p => p.slot), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal((await post('join', { code: first.code, role: 'viewer' })).status, 409);
  await leave(all.pop()); const viewer = await join({ code: first.code, role: 'viewer' });
  assert.equal((await post('join', { code: first.code, role: 'camera' })).status, 409);
  await leave(...all, viewer);
});
test('invalid settings and unauthorized requests are rejected', async () => {
  for (const maxCameras of [0, 11, 2.5, 'bad']) assert.equal((await post('join', { create: true, maxCameras })).status, 400);
  assert.equal((await post('live', { id: null })).status, 401);
});
test('private files stay outside the static allowlist and foreign origins cannot create rooms', async () => {
  for (const path of ['/.env.local', '/.neon', '/.git/config', '/database.mjs', '/data/recordings/manifest.json', '/verification/neon-services.txt', '/%2e%2e/.env.local']) {
    const response = await fetch(`${base}${path}`);
    assert.notEqual(response.status, 200, `private path was exposed: ${path}`);
    assert.match(response.headers.get('content-type'), /application\/json/);
  }
  const foreign = await fetch(`${base}/api/join`, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ create: true }) });
  assert.equal(foreign.status, 403);
});
test('stream announces peers, signals within room, broadcasts tally and removes peers', async () => {
  const a = await join({ create: true, maxCameras: 2 }), aEvents = await events(a);
  assert.equal((await aEvents.next()).type, 'welcome');
  const b = await join({ code: a.code }), bEvents = await events(b);
  assert.equal((await bEvents.next()).data.peers[0].id, a.id);
  assert.equal((await aEvents.next()).type, 'joined');
  const outsider = await join({ create: true });
  assert.equal((await post('signal', { to: outsider.id, sender: a.id, candidate: {} }, a)).status, 404);
  assert.equal((await post('signal', { to: b.id, sender: 'forged' }, a)).status, 400);
  await post('signal', { to: b.id, sender: a.id, description: { type: 'offer', sdp: 'test' } }, a);
  const signal = await bEvents.next(); assert.equal(signal.type, 'signal'); assert.equal(signal.data.from, a.id);
  await post('live', { id: a.id }, b); assert.equal((await aEvents.next()).data.id, a.id); assert.equal((await bEvents.next()).type, 'live');
  await leave(b); assert.equal((await aEvents.next()).type, 'left');
  await leave(a, outsider); aEvents.close(); bEvents.close();
});
test('only host controls a take; every connected camera must be armed', async () => {
  const a = await join({ create: true, maxCameras: 2 }), ae = await events(a); await ae.next();
  const b = await join({ code: a.code }), be = await events(b); await be.next();
  const keys = ['AWS_ENDPOINT_URL_S3', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'offline-test-value';
    assert.equal((await post('record/start', {}, b)).status, 403);
    assert.equal((await post('record/start', {}, a)).status, 409);
    await post('camera-state', { ready: true, mime: 'video/webm', settings: {} }, a);
    await post('camera-state', { ready: true, mime: 'video/webm', settings: {} }, b);
    const start = await post('record/start', {}, a); assert.equal(start.status, 200); assert.equal(start.body.cameraIds.length, 2);
    assert.equal((await post('record/start', {}, a)).status, 409);
    assert.equal((await post('camera-config', { id: b.id, config: {} }, a)).status, 409);
    assert.equal((await post('record/stop', {}, b)).status, 403);
    assert.equal((await post('record/stop', {}, a)).status, 200);
    assert.equal((await post('camera-config', { id: a.id, config: {} }, b)).status, 403);
  } finally {
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    await leave(a, b); ae.close(); be.close();
  }
});
