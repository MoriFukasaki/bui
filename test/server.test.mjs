import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CAMROOM_OFFLINE = '1';
const { server, records } = await import('../server.mjs');
let base;
before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
async function post(path, body, session) {
  const response = await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function join(body) { const r = await post('join', { role: 'camera', name: 'Test', ...body }); assert.equal(r.status, 200); return { ...r.body, cookie: r.cookie }; }
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
test('creator owns the room; members cannot take admin rights after host disconnects', async () => {
  const a = await join({ create: true }), b = await join({ code: a.code });
  assert.ok(a.cookie); assert.equal(b.cookie, undefined);
  assert.equal((await post('record/download', { id: '0'.repeat(32) }, b)).status, 403);
  assert.equal((await post('record/delete', { id: '0'.repeat(32) }, b)).status, 403);
  assert.equal((await fetch(`${base}/api/rooms/${a.code}/videos/${'0'.repeat(32)}`, { headers: { Authorization: `Bearer ${b.token}` } })).status, 403);
  await leave(a);
  const c = await join({ code: b.code }); assert.equal(c.hostId, null);
  assert.equal((await post('record/start', {}, b)).status, 403);
  const response = await fetch(`${base}/api/join`, { method: 'POST', headers: { Cookie: a.cookie }, body: JSON.stringify({ code: a.code, role: 'viewer' }) });
  assert.equal(response.status, 200); const owner = await response.json(); assert.equal(owner.hostId, owner.id);
  assert.equal((await post('record/download', { id: '0'.repeat(32) }, owner)).status, 404);
  for (const endpoint of ['admin/session', 'admin/login', 'admin/recordings', 'admin/download']) assert.notEqual((await post(endpoint, {}, owner)).status, 200);
  await leave(b,c,owner);
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

test('next take deletes old recordings, revokes upload tokens, and scopes manual deletion to its room', async () => {
  const { mkdtemp } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join: joinPath } = await import('node:path');
  const original = { directory: records.directory, remove: records.remove, upload: records.upload };
  records.directory = await mkdtemp(joinPath(tmpdir(), 'camroom-retention-'));
  const deleted = []; records.remove = async job => { deleted.push(job.id); }; records.upload = async (job, source) => { for await (const bytes of source) {} };
  const keys = ['AWS_ENDPOINT_URL_S3','AWS_REGION','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY']; const env = Object.fromEntries(keys.map(key => [key,process.env[key]]));
  const a = await join({ create: true, maxCameras: 1 }), ae = await events(a); await ae.next();
  const b = await join({ code: a.code, role: 'viewer' });
  const other = await join({ create: true });
  try {
    for (const key of keys) process.env[key] = 'offline-test-value';
    await post('camera-state', { ready: true, settings: {} }, a);
    assert.equal((await post('record/start', {}, a)).status, 200);
    const first = (await post('recordings', {}, a)).body.recordings[0];
    await post('record/stop', {}, a);
    assert.equal((await post('record/delete', { id: first.id }, other)).status, 404);
    const manifest = await records.load(first.id);
    // Token is delivered only to the camera; test creates another capability to exercise HTTP revocation.
    const stale = await records.create({ room: a.code, take: first.take, name: 'Test', slot: 1, peerId: a.id });
    await records.chunk(stale.id, stale.token, 0, Buffer.from('media'));
    await records.complete(stale.id, stale.token, { count: 1, mime: 'video/mp4' });
    assert.equal((await post('record/download', { id: stale.id }, b)).status, 403);
    const link = await post('record/download', { id: stale.id }, a); assert.equal(link.status, 200); assert.match(link.body.url, /^\/api\/rooms\//);
    assert.equal((await fetch(base + link.body.url)).status, 403);
    assert.equal((await post('record/start', {}, a)).status, 200);
    const latest = (await post('recordings', {}, a)).body.recordings;
    assert.equal(latest.length, 1); assert.notEqual(latest[0].take, first.take);
    assert.ok(deleted.includes(first.id)); assert.ok(deleted.includes(stale.id));
    assert.equal((await fetch(`${base}/api/uploads/${stale.id}/status`, { headers: { Authorization: `Bearer ${stale.token}` } })).status, 410);
    assert.equal((await fetch(base + link.body.url, { headers: { Cookie: a.cookie } })).status, 404);
    assert.equal((await post('record/delete', { id: latest[0].id }, a)).status, 409);
    await post('record/stop', {}, a);
    assert.equal((await post('record/delete', { id: latest[0].id }, b)).status, 403);
    assert.equal((await post('record/delete', { id: latest[0].id }, a)).status, 200);
    assert.equal((await post('recordings', {}, a)).body.recordings.length, 0);
  } finally {
    for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
    Object.assign(records, original); await leave(a,b,other); ae.close();
  }
});
