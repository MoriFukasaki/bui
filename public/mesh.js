// Each camera has a separately versioned send connection to each peer.
// A failed pair must never prevent negotiation with the other devices.
export class CameraMesh {
  constructor({ selfId, peers, getStream, getConfiguration, getPreview, send, onStream, onState,
    createPeer = config => new RTCPeerConnection(config), setTimer = (fn, delay) => setTimeout(fn, delay), clearTimer = id => clearTimeout(id),
    newId = () => crypto.randomUUID() }) {
    Object.assign(this, { selfId, peers, getStream, getConfiguration, getPreview, send, onStream, onState, createPeer, setTimer, clearTimer, newId });
    this.outgoing = new Map(); this.incoming = new Map(); this.states = new WeakMap(); this.pending = new Map();
    this.retired = new Set(); this.retries = new Map(); this.requestTimers = new Map(); this.closed = false;
  }
  config(relay = false) {
    const config = this.getConfiguration();
    return { iceServers: config.iceServers, iceTransportPolicy: relay && config.turnConfigured ? 'relay' : config.iceTransportPolicy || 'all' };
  }
  current(other, receiving, pc) { return !this.closed && (receiving ? this.incoming : this.outgoing).get(other) === pc; }
  notify(other, direction, status) { if (!this.closed) this.onState?.(other, direction, status); }
  dispose(pc) {
    if (!pc) return;
    const state = this.states.get(pc); if (state) { state.cancelled = true; this.clearTimer(state.timer); this.retired.add(state.id); }
    pc.onicecandidate = pc.onconnectionstatechange = pc.oniceconnectionstatechange = pc.ontrack = null;
    pc.close();
    // Only recent generations are relevant. Peer ids and connection ids are unguessable/session scoped.
    if (this.retired.size > 256) this.retired.delete(this.retired.values().next().value);
  }
  make(other, id, receiving, relay) {
    const pc = this.createPeer(this.config(relay));
    const state = { id, other, receiving, localCandidates: [], descriptionSent: false, flushing: false, cancelled: false, timer: null, createdAt: Date.now() };
    this.states.set(pc, state); (receiving ? this.incoming : this.outgoing).set(other, pc);
    pc.onicecandidate = event => {
      if (!event.candidate || !this.current(other, receiving, pc)) return;
      state.localCandidates.push(event.candidate.toJSON?.() || event.candidate);
      this.flushLocal(pc).catch(() => this.retry(other, receiving, pc));
    };
    const changed = () => {
      if (!this.current(other, receiving, pc)) return;
      const ice = pc.iceConnectionState, connection = pc.connectionState;
      if (connection === 'connected' || ice === 'connected' || ice === 'completed') {
        this.clearTimer(state.timer); state.timer = null; this.retries.delete(`${receiving}:${other}`);
        if (receiving) this.notify(other, 'receive', 'connected');
        else { this.notify(other, 'send', 'connected'); this.applyPreview(pc).catch(() => {}); }
      } else if (connection === 'failed' || ice === 'failed') this.retry(other, receiving, pc);
      else if (connection === 'disconnected' || ice === 'disconnected') {
        this.notify(other, receiving ? 'receive' : 'send', 'disconnected'); this.retry(other, receiving, pc, 7000);
      }
    };
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = changed;
    if (receiving) pc.ontrack = event => { if (this.current(other, true, pc)) this.onStream(other, event.streams?.[0] || new MediaStream([event.track]), event.track); };
    state.timer = this.setTimer(() => { state.timer = null; this.retry(other, receiving, pc); }, 20000);
    return pc;
  }
  async flushLocal(pc) {
    const state = this.states.get(pc);
    if (!state?.descriptionSent || state.flushing || state.cancelled) return;
    state.flushing = true;
    try {
      while (state.localCandidates.length && !state.cancelled && !this.closed) {
        const candidate = state.localCandidates.shift();
        await this.send({ to: state.other, sender: state.receiving ? state.other : this.selfId, connectionId: state.id, candidate });
      }
    } finally { state.flushing = false; }
  }
  async applyPreview(pc) {
    const options = this.getPreview(), track = this.getStream()?.getVideoTracks()[0];
    const sender = pc.getSenders().find(sender => sender.track?.kind === 'video'); if (!sender) return;
    const params = sender.getParameters(); if (!params.encodings?.length) return;
    const settings = track?.getSettings?.() || {};
    const scale = Math.max(1, Math.max(settings.width || 0, settings.height || 0) / (options.maxDimension || 854));
    for (const encoding of params.encodings) { encoding.maxBitrate = options.bitrate; encoding.maxFramerate = options.fps || 15; encoding.scaleResolutionDownBy = scale; }
    try { await sender.setParameters(params); }
    catch {
      // Some Safari versions cannot change scale/framerate through RTP parameters. Keep the bitrate cap where supported.
      const fallback = sender.getParameters();
      if (fallback.encodings?.length) { for (const encoding of fallback.encodings) encoding.maxBitrate = options.bitrate; await sender.setParameters(fallback); }
    }
  }
  async ensureSender(other, { force = false, relay = false } = {}) {
    if (this.closed || !this.peers.has(other) || !this.getStream()) return;
    const old = this.outgoing.get(other);
    if (old && !force) return;
    this.dispose(old);
    let pc;
    try {
      pc = this.make(other, this.newId(), false, relay);
      for (const track of this.getStream().getVideoTracks()) pc.addTrack(track, this.getStream());
      await pc.setLocalDescription(await pc.createOffer());
      if (!this.current(other, false, pc)) return;
      const state = this.states.get(pc);
      await this.send({ to: other, sender: this.selfId, connectionId: state.id, description: pc.localDescription });
      if (!this.current(other, false, pc)) return;
      state.descriptionSent = true; await this.flushLocal(pc);
    } catch {
      if (pc) this.retry(other, false, pc);
      else this.notify(other, 'send', 'failed');
    }
  }
  async connectAll() {
    const work = [];
    for (const peer of this.peers.values()) {
      if (this.getStream()) work.push(this.ensureSender(peer.id));
      if (peer.role === 'camera') this.waitForOffer(peer.id);
    }
    await Promise.allSettled(work);
  }
  waitForOffer(other) {
    if (this.closed || this.incoming.has(other) || this.requestTimers.has(other)) return;
    const timer = this.setTimer(() => {
      this.requestTimers.delete(other);
      if (this.incoming.has(other)) return;
      const key = `true:${other}`, attempts = this.retries.get(key) || 0;
      if (attempts >= 3) { this.notify(other, 'receive', 'failed'); return; }
      this.retries.set(key, attempts + 1); this.requestOffer(other).catch(() => this.waitForOffer(other));
    }, 12000);
    this.requestTimers.set(other, timer);
  }
  retry(other, receiving, pc, delay = 1000) {
    if (!this.current(other, receiving, pc)) return;
    const state = this.states.get(pc), key = `${receiving}:${other}`;
    this.clearTimer(state.timer);
    const attempts = this.retries.get(key) || 0;
    if (attempts >= 3) { state.timer = null; this.notify(other, receiving ? 'receive' : 'send', 'failed'); return; }
    this.notify(other, receiving ? 'receive' : 'send', 'retrying');
    state.timer = this.setTimer(() => {
      state.timer = null;
      if (!this.current(other, receiving, pc)) return;
      this.retries.set(key, attempts + 1);
      if (receiving) this.requestOffer(other).then(() => {
        if (this.current(other, true, pc)) state.timer = this.setTimer(() => { state.timer = null; this.retry(other, true, pc); }, 20000);
      }).catch(() => this.retry(other, true, pc));
      else this.ensureSender(other, { force: true, relay: true });
    }, delay);
  }
  async requestOffer(other) {
    if (this.closed || this.peers.get(other)?.role !== 'camera') return;
    await this.send({ to: other, sender: other, restart: true, relay: Boolean(this.getConfiguration().turnConfigured) });
    if (!this.closed && !this.incoming.has(other)) this.waitForOffer(other);
  }
  async reconnect(other) {
    this.retries.delete(`true:${other}`); this.retries.delete(`false:${other}`);
    this.notify(other, 'receive', 'retrying');
    await Promise.allSettled([this.requestOffer(other), this.ensureSender(other, { force: true, relay: true })]);
  }
  async addPending(pc) {
    const state = this.states.get(pc), key = `${state.receiving}:${state.other}:${state.id}`;
    const candidates = this.pending.get(key) || []; this.pending.delete(key);
    for (const candidate of candidates) await pc.addIceCandidate(candidate);
  }
  async receive({ from, sender, connectionId, description, candidate, restart, relay }) {
    if (this.closed || !this.peers.has(from)) return;
    if (restart) {
      if (sender !== this.selfId || !this.getStream()) return;
      const pc = this.outgoing.get(from), state = pc && this.states.get(pc);
      // Repeated requests during the same negotiation should not keep destroying an otherwise viable pair.
      if (state && Date.now() - state.createdAt < 2500 && pc.signalingState === 'have-local-offer') return;
      await this.ensureSender(from, { force: true, relay: Boolean(relay) }); return;
    }
    if (typeof connectionId !== 'string' || this.retired.has(connectionId)) return;
    const receiving = sender === from;
    if (!receiving && sender !== this.selfId) return;
    const map = receiving ? this.incoming : this.outgoing;
    let pc = map.get(from), state = pc && this.states.get(pc);
    if (description?.type === 'offer' && receiving) {
      if (this.peers.get(from).role !== 'camera' || state?.id === connectionId) return;
      this.clearTimer(this.requestTimers.get(from)); this.requestTimers.delete(from);
      this.dispose(pc); pc = this.make(from, connectionId, true, false); state = this.states.get(pc);
      try {
        await pc.setRemoteDescription(description); await this.addPending(pc);
        await pc.setLocalDescription(await pc.createAnswer());
        await this.send({ to: from, sender: from, connectionId, description: pc.localDescription });
        if (!this.current(from, true, pc)) return;
        state.descriptionSent = true; await this.flushLocal(pc);
      } catch { this.retry(from, true, pc); }
    } else if (description?.type === 'answer' && !receiving && state?.id === connectionId) {
      try { await pc.setRemoteDescription(description); await this.addPending(pc); await this.applyPreview(pc).catch(() => {}); }
      catch { this.retry(from, false, pc); }
    } else if (candidate) {
      if (state?.id === connectionId && pc.remoteDescription) {
        try { await pc.addIceCandidate(candidate); } catch { this.retry(from, receiving, pc); }
      } else {
        const key = `${receiving}:${from}:${connectionId}`, list = this.pending.get(key) || [];
        if (this.pending.size < 100 && list.length < 64) { list.push(candidate); this.pending.set(key, list); }
      }
    }
  }
  remove(other) {
    this.dispose(this.outgoing.get(other)); this.outgoing.delete(other);
    this.dispose(this.incoming.get(other)); this.incoming.delete(other);
    this.clearTimer(this.requestTimers.get(other)); this.requestTimers.delete(other);
    this.retries.delete(`true:${other}`); this.retries.delete(`false:${other}`);
    for (const key of this.pending.keys()) if (key.includes(`:${other}:`)) this.pending.delete(key);
  }
  close() {
    this.closed = true;
    for (const pc of [...this.outgoing.values(), ...this.incoming.values()]) this.dispose(pc);
    for (const timer of this.requestTimers.values()) this.clearTimer(timer);
    this.outgoing.clear(); this.incoming.clear(); this.pending.clear(); this.requestTimers.clear(); this.retries.clear();
  }
}
