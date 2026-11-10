import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingController } from '../public/recorder.js';
import { createLocalStore } from '../public/recording-storage.js';

const settle = async check => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('recording work did not settle');
};
function browser(t) {
  const listeners = {}, intervals = [], recorders = [];
  const install = (name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  };
  const element = () => ({ append() {}, replaceChildren() {}, hidden: false });
  t.mock.method(globalThis, 'setInterval', fn => { intervals.push(fn); return 0; });
  install('window', { addEventListener: (type, fn) => { listeners[type] = fn; } });
  install('document', { getElementById: element, createElement: element });
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream, options) { this.stream = stream; this.options = options; this.mimeType = options.mimeType; this.videoBitsPerSecond = options.videoBitsPerSecond; recorders.push(this); }
    start() { this.state = 'recording'; }
    emit(data) { this.ondataavailable({ data: new Blob([data]) }); }
    stop() { this.state = 'inactive'; this.emit('tail'); this.onstop(); }
  }
  install('MediaRecorder', Recorder);
  install('MediaStream', class { constructor(tracks) { this.tracks = tracks; } });
  const track = { enabled: true, readyState: 'live', getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }) };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  return { listeners, intervals, recorders, stream };
}
test('three cameras keep original chunks locally during capture, then upload every byte only after stop', async t => {
  const env = browser(t), calls = [], received = new Map(), controllers = [], stores = [];
  let unavailable = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    if (unavailable) return { status: 410, ok: false };
    if (url.endsWith('/status')) return { status: 200, ok: true, json: async () => ({ next: 0 }) };
    if (url.includes('/chunk?')) {
      const id = url.split('/')[3]; received.set(id, (received.get(id) || '') + await options.body.text());
    }
    return { status: 200, ok: true, json: async () => ({}) };
  });
  let roomActive = true;
  for (let i = 0; i < 3; i++) {
    const store = createLocalStore({ indexedDB: null }); stores.push(store);
    const control = createRecordingController({ store, api: async () => ({}), getStream: () => env.stream, getOptions: () => ({ bitrate: 10000000 }), notify() {}, onState() {}, canUpload: () => !roomActive });
    controllers.push(control);
    await control.start({ id: `cam${i}`, room: 'ROOM', take: 'take', token: 'test', createdAt: i }, 0);
  }
  await settle(() => env.recorders.length === 3 && env.recorders.every(rec => rec.state === 'recording'));
  env.recorders.forEach((rec, i) => { rec.emit(`original${i}`); });
  await settle(async () => (await Promise.all(stores.map((store, i) => store.get(`cam${i}`)))).every(job => job.count === 1));
  await Promise.all(env.intervals.map(fn => fn()));
  assert.equal(calls.length, 0, 'no status/chunk/complete upload traffic during capture');
  for (const rec of env.recorders) {
    assert.equal(rec.options.videoBitsPerSecond, 10000000);
    assert.deepEqual(rec.stream.tracks[0].getSettings(), { width: 1920, height: 1080, frameRate: 30 });
  }
  await controllers[0].stop();
  assert.equal(calls.length, 0, 'one stopped camera waits while the other cameras still record');
  roomActive = false;
  await Promise.all(controllers.slice(1).map(controller => controller.stop()));
  await Promise.all(env.intervals.map(fn => fn()));
  await settle(async () => (await Promise.all(stores.map((store, i) => store.get(`cam${i}`)))).every(job => job.uploaded));
  for (let i = 0; i < 3; i++) assert.equal(received.get(`cam${i}`), `original${i}tail`, 'original bytes and final chunk survive upload unchanged');
  // Losing a server spool, or rejoining after missing metadata, must not erase
  // the sole original before upload has succeeded.
  const pending = { id: 'pending', room: 'ROOM', take: 'older', count: 0, bytes: 0, final: true };
  await stores[0].put(pending); await stores[0].append(pending, new Blob(['keep-me']));
  await controllers[0].reconcile('ROOM', 'newer', []);
  await controllers[0].retainRoomTake('ROOM', 'newer');
  assert.equal(await (await stores[0].chunk('pending', 0)).blob.text(), 'keep-me');
  unavailable = true; await env.intervals[0]();
  await settle(async () => Boolean((await stores[0].get('pending'))?.error));
  assert.equal(await (await stores[0].chunk('pending', 0)).blob.text(), 'keep-me', 'HTTP 410 preserves local original');
  await controllers[0].discard(['pending']);
  assert.equal(await stores[0].get('pending'), undefined, 'explicit admin deletion still clears the copy');
});
