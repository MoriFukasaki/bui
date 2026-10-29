import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraMesh } from '../public/mesh.js';

class FakePeer {
  constructor(configuration, failOffer = false) {
    this.configuration = configuration; this.failOffer = failOffer; this.candidates = []; this.senders = [];
    this.connectionState = this.iceConnectionState = 'new'; this.signalingState = 'stable';
  }
  addTrack(track) {
    this.senders.push({ track, getParameters: () => ({ encodings: [{}] }), setParameters: async params => { this.parameters = params; } });
  }
  getSenders() { return this.senders; }
  async createOffer() { if (this.failOffer) throw Error('Synthetic codec failure'); return { type: 'offer', sdp: 'test-offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'test-answer' }; }
  async setLocalDescription(description) {
    this.localDescription = description; this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    // The browser may gather a candidate before the application's description POST has completed.
    this.onicecandidate?.({ candidate: { candidate: 'synthetic-candidate' } });
  }
  async setRemoteDescription(description) { this.remoteDescription = description; this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async addIceCandidate(candidate) { assert.ok(this.remoteDescription, 'ICE applied before remote SDP'); this.candidates.push(candidate); }
  connected() { this.connectionState = this.iceConnectionState = 'connected'; this.onconnectionstatechange?.(); }
  failed() { this.connectionState = this.iceConnectionState = 'failed'; this.oniceconnectionstatechange?.(); }
  close() { this.connectionState = this.iceConnectionState = 'closed'; this.closed = true; }
}
function network(size, { failFirstOffer = false, turn = false } = {}) {
  const messages = [], nodes = [], created = [], notifications = [];
  let timerId = 0;
  for (let i = 0; i < size; i++) {
    const selfId = `device-${i}`, timers = new Map(); let generation = 0, pcCount = 0;
    const peers = new Map(Array.from({ length: size }, (_, j) => [`device-${j}`, { id: `device-${j}`, role: 'camera' }]).filter(([id]) => id !== selfId));
    const videoTrack = { kind: 'video', getSettings: () => ({ width: 1920, height: 1080 }) }, stream = { getVideoTracks: () => [videoTrack] };
    const mesh = new CameraMesh({ selfId, peers, getStream: () => stream,
      getConfiguration: () => ({ iceServers: [], iceTransportPolicy: 'all', turnConfigured: turn }), getPreview: () => ({ bitrate: 400000, fps: 15, maxDimension: 854 }),
      newId: () => `${selfId}-generation-${++generation}`,
      createPeer: config => { const pc = new FakePeer(config, failFirstOffer && i === 0 && pcCount++ === 0); created.push(pc); return pc; },
      send: async data => { messages.push({ ...data, from: selfId }); }, onStream: () => {}, onState: (...data) => notifications.push(data),
      setTimer: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimer: id => timers.delete(id),
    });
    nodes.push({ mesh, timers });
  }
  async function flush(candidateFirst = false) {
    let count = 0;
    while (messages.length) {
      assert.ok(++count < 10000, 'signaling loop');
      const preferred = candidateFirst ? messages.findIndex(message => message.candidate) : -1;
      const [message] = messages.splice(preferred >= 0 ? preferred : 0, 1);
      const recipient = nodes[Number(message.to.split('-')[1])];
      await recipient.mesh.receive(message);
    }
  }
  async function fireRetry(index) {
    const node = nodes[index], entry = [...node.timers].find(([, timer]) => timer.delay === 1000);
    assert.ok(entry, 'missing automatic retry'); node.timers.delete(entry[0]); entry[1].fn();
    await new Promise(resolve => setImmediate(resolve)); await flush();
  }
  return { nodes, messages, created, notifications, flush, fireRetry, close: () => nodes.forEach(node => node.mesh.close()) };
}

test('all ten cameras negotiate all 90 directions, even when ICE arrives before SDP', async () => {
  const net = network(10);
  try {
    await Promise.all(net.nodes.map(node => node.mesh.connectAll())); await net.flush(true);
    for (const { mesh } of net.nodes) {
      assert.equal(mesh.outgoing.size, 9); assert.equal(mesh.incoming.size, 9);
      for (const pc of mesh.outgoing.values()) { assert.equal(pc.remoteDescription.type, 'answer'); assert.equal(pc.candidates.length, 1); assert.equal(pc.parameters.encodings[0].maxBitrate, 400000); }
      for (const pc of mesh.incoming.values()) { assert.equal(pc.remoteDescription.type, 'offer'); assert.equal(pc.candidates.length, 1); }
    }
  } finally { net.close(); }
});
test('one failed offer cannot prevent negotiation with other cameras', async () => {
  const net = network(3, { failFirstOffer: true });
  try {
    await Promise.all(net.nodes.map(node => node.mesh.connectAll())); await net.flush();
    assert.equal(net.nodes[0].mesh.outgoing.get('device-2').remoteDescription.type, 'answer');
    await net.fireRetry(0);
    assert.equal(net.nodes[0].mesh.outgoing.get('device-1').remoteDescription.type, 'answer');
  } finally { net.close(); }
});
test('unsupported sender parameter controls do not tear down a negotiated camera', async () => {
  const net = network(2);
  try {
    await Promise.all(net.nodes.map(node => node.mesh.connectAll()));
    for (const pc of net.created) for (const sender of pc.senders) sender.setParameters = async () => { throw Error('Synthetic Safari limitation'); };
    await net.flush();
    for (const { mesh } of net.nodes) assert.equal(mesh.outgoing.values().next().value.remoteDescription.type, 'answer');
    assert.ok(!net.notifications.some(([, , status]) => status === 'retrying'));
  } finally { net.close(); }
});
test('failed sender retries only that direction, uses relay fallback, and ignores old ICE', async () => {
  const net = network(3, { turn: true });
  try {
    await Promise.all(net.nodes.map(node => node.mesh.connectAll())); await net.flush();
    const sender = net.nodes[0].mesh, receiver = net.nodes[1].mesh;
    const old = sender.outgoing.get('device-1'), oldId = sender.states.get(old).id, untouched = sender.outgoing.get('device-2');
    old.failed(); await net.fireRetry(0);
    const replacement = sender.outgoing.get('device-1');
    assert.notEqual(replacement, old); assert.equal(old.closed, true); assert.equal(replacement.configuration.iceTransportPolicy, 'relay');
    assert.equal(sender.outgoing.get('device-2'), untouched);
    const incoming = receiver.incoming.get('device-0'), count = incoming.candidates.length;
    await receiver.receive({ from: 'device-0', sender: 'device-0', connectionId: oldId, candidate: { candidate: 'stale-candidate' } });
    assert.equal(incoming.candidates.length, count);
  } finally { net.close(); }
});
test('a receiver can request a new offer and closed sessions reject late traffic', async () => {
  const net = network(2);
  try {
    await Promise.all(net.nodes.map(node => node.mesh.connectAll())); await net.flush();
    const receiver = net.nodes[1].mesh, before = receiver.incoming.get('device-0');
    before.failed(); await net.fireRetry(1);
    assert.notEqual(receiver.incoming.get('device-0'), before);
    receiver.close();
    await receiver.receive({ from: 'device-0', sender: 'device-0', connectionId: 'late-offer', description: { type: 'offer', sdp: 'late' } });
    assert.equal(receiver.incoming.size, 0);
  } finally { net.close(); }
});
test('default timer wrappers do not bind browser timer functions to the mesh instance', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let nextTimer = 0;
  globalThis.setTimeout = function () { assert.ok(!(this instanceof CameraMesh), 'illegal browser timer receiver'); return ++nextTimer; };
  globalThis.clearTimeout = function () { assert.ok(!(this instanceof CameraMesh), 'illegal browser timer receiver'); };
  const stream = { getVideoTracks: () => [{ kind: 'video' }] };
  const mesh = new CameraMesh({ selfId: 'local', peers: new Map([['other', { id: 'other', role: 'camera' }]]),
    getStream: () => stream, getConfiguration: () => ({ iceServers: [] }), getPreview: () => ({ bitrate: 400000 }),
    createPeer: config => new FakePeer(config), send: async () => {}, onStream: () => {}, onState: () => {} });
  try { await mesh.connectAll(); assert.ok(nextTimer >= 2); }
  finally { mesh.close(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});
