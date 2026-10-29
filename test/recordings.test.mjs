import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingStore } from '../recordings.mjs';
test('ordered chunks are idempotent, complete once and survive store restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'camroom-recording-test-')); let uploads = 0;
  const upload = async (job, source) => { let bytes = ''; for await (const chunk of source) bytes += chunk; assert.equal(bytes, 'firstsecond'); uploads++; };
  const store = new RecordingStore({ directory, upload });
  const job = await store.create({ room: 'TEST', slot: 1, take: 'take-1', peerId: 'phone' });
  await assert.rejects(() => store.chunk(job.id, 'wrong', 0, Buffer.from('first')));
  await assert.rejects(() => store.chunk(job.id, job.token, 1, Buffer.from('second')));
  await store.chunk(job.id, job.token, 0, Buffer.from('first'));
  await store.chunk(job.id, job.token, 0, Buffer.from('first'));
  await assert.rejects(() => store.chunk(job.id, job.token, 0, Buffer.from('changed')));
  const resumed = new RecordingStore({ directory, upload });
  await resumed.chunk(job.id, job.token, 1, Buffer.from('second'));
  await assert.rejects(() => resumed.complete(job.id, job.token, { count: 3, mime: 'video/webm' }));
  const done = await resumed.complete(job.id, job.token, { count: 2, mime: 'video/webm', actualStartedAt: 1000, actualStoppedAt: 6000, clockOffset: 250 });
  assert.equal(done.state, 'uploaded'); assert.equal(done.bytes, 11); assert.ok(!('tokenHash' in done));
  assert.equal(done.actualStartedServerAt, 1250); assert.equal(done.actualStoppedServerAt, 6250);
  await resumed.complete(job.id, job.token, { count: 2, mime: 'video/webm' }); assert.equal(uploads, 1);
});
test('bucket failure preserves spool and can be retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'camroom-retry-test-'));
  const store = new RecordingStore({ directory, upload: async () => { throw Error('offline'); } });
  const job = await store.create({ room: 'TEST', slot: 2, take: 'take-2', peerId: 'phone' });
  await store.chunk(job.id, job.token, 0, Buffer.from('video'));
  await assert.rejects(() => store.complete(job.id, job.token, { count: 1, mime: 'video/mp4' }));
  assert.equal((await store.load(job.id)).state, 'upload-failed');
  const retry = new RecordingStore({ directory, upload: async (job, source) => { for await (const chunk of source) assert.equal(chunk.toString(), 'video'); } });
  assert.equal((await retry.complete(job.id, job.token, { count: 1, mime: 'video/mp4' })).state, 'uploaded');
});
test('same-size disk corruption cannot be marked uploaded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'camroom-corrupt-test-'));
  const store = new RecordingStore({ directory, upload: async (job, source) => { for await (const chunk of source) {} } });
  const job = await store.create({ room: 'TEST', slot: 1, take: 'corruption', peerId: 'phone' });
  await store.chunk(job.id, job.token, 0, Buffer.from('valid'));
  await writeFile(join(directory, job.id, '0.bin'), 'wrong');
  await assert.rejects(() => store.complete(job.id, job.token, { count: 1, mime: 'video/mp4' }));
  assert.equal((await store.load(job.id)).state, 'upload-failed');
});
test('invalid MIME header and contradictory timestamps cannot complete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'camroom-input-test-'));
  const store = new RecordingStore({ directory, upload: async () => { assert.fail('Invalid input must not reach storage'); } });
  const job = await store.create({ room: 'TEST', slot: 1, take: 'invalid', peerId: 'phone' });
  await store.chunk(job.id, job.token, 0, Buffer.from('video'));
  await assert.rejects(() => store.complete(job.id, job.token, { count: 1, mime: 'video/mp4;\r\nX-Test: injected' }));
  await assert.rejects(() => store.complete(job.id, job.token, { count: 1, mime: 'video/mp4', actualStartedAt: 200, actualStoppedAt: 100 }));
});
test('deletion waits for in-flight upload then revokes every retry without resurrecting media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'camroom-delete-race-')); let finish, started;
  const uploadStarted = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { finish = resolve; }); const order = [];
  const store = new RecordingStore({ directory, upload: async (job, source) => { for await (const chunk of source) {} started(); await wait; order.push('upload'); }, remove: async () => { order.push('delete'); } });
  const job = await store.create({ room: 'ROOM', take: 'take', slot: 1 });
  await store.chunk(job.id, job.token, 0, Buffer.from('video'));
  const upload = store.complete(job.id, job.token, { count: 1, mime: 'video/mp4' }); await uploadStarted;
  const deletion = store.delete(job); finish(); await upload; await deletion;
  assert.deepEqual(order, ['upload','delete']);
  await assert.rejects(() => store.chunk(job.id, job.token, 1, Buffer.from('late')), { code: 'RECORDING_GONE' });
  await assert.rejects(() => store.complete(job.id, job.token, { count: 1, mime: 'video/mp4' }), { code: 'RECORDING_GONE' });
  assert.deepEqual(await store.listRoom('ROOM'), []);
});
test('failed cloud deletion keeps a revoked tombstone and can be retried with metadata after losing spool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'camroom-delete-retry-')); let fail = true;
  const store = new RecordingStore({ directory, remove: async () => { if (fail) throw Error('cloud offline'); } });
  const job = await store.create({ room: 'ROOM', take: 'take', slot: 1 });
  await assert.rejects(() => store.delete(job), /cloud offline/);
  await assert.rejects(() => store.authenticated(job.id, job.token), { code: 'RECORDING_GONE' });
  fail = false; await store.delete(job); assert.deepEqual(await store.listRoom('ROOM'), []);
  // DB metadata is enough to retry deletion if an ephemeral server lost its spool.
  await store.delete(job); assert.deepEqual(await store.listRoom('ROOM'), []);
});
