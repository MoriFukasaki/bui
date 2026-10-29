import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStore } from '../public/recording-storage.js';
test('unavailable phone storage falls back, preserves final metadata and releases only acknowledged chunks', async () => {
  const warnings = [], store = createLocalStore({ indexedDB: null, maxMemoryBytes: 8, warn: text => warnings.push(text) });
  const job = { id: 'phone', count: 0, bytes: 0, final: false };
  await store.put(job); await store.append(job, new Blob(['first']));
  assert.equal(await (await store.chunk(job.id, 0)).blob.text(), 'first');
  await assert.rejects(() => store.append(job, new Blob(['more'])), /Bộ nhớ tạm/);
  assert.equal(job.count, 1);
  store.acknowledge(job.id, 1);
  await store.append(job, new Blob(['last']));
  await store.patch(job.id, { final: true, actualStoppedAt: 1234 });
  const saved = await store.get(job.id);
  assert.equal(saved.count, 2); assert.equal(saved.bytes, 9); assert.equal(saved.final, true);
  assert.equal(saved.localIncomplete, true); assert.equal(saved.volatile, true);
  assert.equal(await (await store.chunk(job.id, 1)).blob.text(), 'last');
  assert.equal(warnings.length, 1); assert.equal((await store.list()).length, 1);
});
