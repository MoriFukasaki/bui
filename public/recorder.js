import { createLocalStore } from './recording-storage.js';
export const supportedMime = () => {
  if (!globalThis.MediaRecorder) return '';
  return ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type)) || '';
};
export function createRecordingController({ api, getStream, getOptions, onState, notify, store = createLocalStore({ warn: notify }) }) {
  const putJob = store.put, getJob = store.get, updateJob = store.patch, jobs = store.list, getChunk = store.chunk;
  let active = null;
  const uploads = new Map(), retries = new Map(), discarded = new Set();
  async function uploadRequest(job, suffix, body, type) {
    const response = await fetch(`/api/uploads/${job.id}/${suffix}`, { method: 'POST', headers: { Authorization: `Bearer ${job.token}`, 'Content-Type': type }, body, signal: AbortSignal.timeout(suffix === 'complete' ? 180000 : 30000) });
    if (response.status === 410) { await discard([job.id]); throw Error('Video đã bị admin xóa.'); }
    const data = await response.json(); if (!response.ok) throw Error(data.error || 'Upload thất bại.'); return data;
  }
  async function refresh() {
    try {
      const list = (await jobs()).sort((a, b) => b.createdAt - a.createdAt);
      const root = document.getElementById('local-recordings'); root.replaceChildren();
      document.getElementById('recovery').hidden = !list.length;
      for (const job of list) {
        const row = document.createElement('div'); row.className = 'local-recording';
        const text = document.createElement('span');
        text.textContent = `CAM ${job.slot} · ${job.take} · ${job.uploaded ? 'Đã lưu Neon' : job.error || (job.final ? 'Chờ tải lên' : 'Đang ghi / bản chưa hoàn tất')} · ${(job.bytes / 1048576).toFixed(1)} MB`;
        row.append(text);
        if (job.final && !job.uploaded) {
          const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = 'Thử tải lên Neon'; retry.disabled = uploads.has(job.id);
          retry.onclick = () => { retries.delete(job.id); pump(job.id); }; row.append(retry);
        }
        root.append(row);
      }
    } catch (error) { notify(`Không truy cập được bộ nhớ video: ${error.message}`); }
  }
  async function pump(id) {
    if (discarded.has(id)) return;
    if (uploads.has(id)) return uploads.get(id);
    const retry = retries.get(id); if (retry && (retry.count >= 6 || retry.after > Date.now())) return;
    const task = (async () => {
      let job;
      try {
        job = await getJob(id); if (!job || job.uploaded) return;
        const status = await fetch(`/api/uploads/${id}/status`, { headers: { Authorization: `Bearer ${job.token}` }, signal: AbortSignal.timeout(30000) });
        if (status.status === 410) { await discard([id]); return; }
        if (!status.ok) throw Error('Không truy cập được phiên upload trên server.');
        const remote = await status.json();
        let index = remote.next || 0; store.acknowledge(id, index);
        while (true) {
          job = await getJob(id);
          if (!job || discarded.has(id)) return;
          if (index >= job.count) break;
          const chunk = await getChunk(id, index); if (!chunk) throw Error('Thiếu dữ liệu lưu trên máy.');
          await uploadRequest(job, `chunk?index=${index}`, chunk.blob, 'application/octet-stream'); index++; store.acknowledge(id, index);
        }
        job = await getJob(id);
        if (!job || discarded.has(id)) return;
        if (job.final) {
          await uploadRequest(job, 'complete', JSON.stringify({ count: job.count, mime: job.mime, actualStartedAt: job.actualStartedAt, actualStoppedAt: job.actualStoppedAt, clockOffset: job.clockOffset, capture: job.capture }), 'application/json');
          job.uploaded = true;
        }
        await updateJob(id, { error: '', ...(job.uploaded ? { uploaded: true } : {}) });
        retries.delete(id);
      } catch (error) {
        if (discarded.has(id)) return;
        const count = (retries.get(id)?.count || 0) + 1;
        retries.set(id, { count, after: Date.now() + Math.min(60000, 5000 * 2 ** (count - 1)) });
        if (job) await updateJob(id, { error: error.message }).catch(() => {});
        notify(`${job?.volatile ? "Giữ trang mở: video đang dùng bộ nhớ tạm." : "Video vẫn được giữ trên thiết bị."} ${error.message}`);
      }
    })();
    uploads.set(id, task);
    try { await task; } finally { uploads.delete(id); await refresh(); }
  }
  async function start(job, delay) {
    await retainRoomTake(job.room, job.take);
    if (active) { await api('record/ack', { id: job.id, state: 'failed', error: 'Thiết bị đang xử lý lượt quay trước.' }); return; }
    const source = getStream();
    if (!source || !source.getVideoTracks().some(t => t.readyState === 'live' && t.enabled)) {
      await api('record/ack', { id: job.id, state: 'failed', error: 'Camera chưa sẵn sàng.' }); return;
    }
    const local = { ...job, mime: supportedMime(), count: 0, bytes: 0, final: false, uploaded: false };
    if (!local.mime) { await api('record/ack', { id: job.id, state: 'failed', error: 'Trình duyệt không hỗ trợ ghi video.' }); return; }
    // Write the upload capability before recording begins so retry survives a page reload.
    try { await putJob(local); } catch { await api('record/ack', { id: job.id, state: 'failed', error: 'Không đủ bộ nhớ trên thiết bị.' }); return; }
    const state = { id: job.id, take: job.take, recorder: null, timer: null, writing: Promise.resolve(), complete: null, failed: false };
    active = state; onState(true);
    state.timer = setTimeout(async () => {
      if (active !== state) return;
      try {
        const captureTrack = source.getVideoTracks()[0];
        const rec = new MediaRecorder(new MediaStream(source.getTracks()), { mimeType: local.mime, videoBitsPerSecond: getOptions().bitrate, audioBitsPerSecond: 128000 });
        state.recorder = rec; local.mime = rec.mimeType || local.mime;
        const actual = captureTrack.getSettings();
        local.capture = { width: actual.width, height: actual.height, frameRate: actual.frameRate,
          requestedBitrate: getOptions().bitrate, encoderBitrate: rec.videoBitsPerSecond, mime: local.mime };
        // Discourage WebRTC from lowering the shared capture track under congestion.
        captureTrack.contentHint = 'detail';
        rec.ondataavailable = e => {
          if (!e.data.size) return;
          state.writing = state.writing.then(async () => {
            for (let offset = 0; offset < e.data.size; offset += 2 * 1024 * 1024) {
              const blob = e.data.slice(offset, offset + 2 * 1024 * 1024);
              await store.append(local, blob);
            }
            // Upload runs independently; local chunks remain available until explicitly cleared by the browser/user.
            pump(local.id); refresh();
          }).catch(error => { state.failed = true; state.error = `${error.name || 'StorageError'}: ${error.message}`; notify(`Lỗi lưu video: ${state.error}`); if (rec.state !== 'inactive') rec.stop(); });
        };
        state.complete = new Promise(resolve => {
          rec.onstop = async () => {
            try {
              await state.writing;
              if (!local.count) { state.failed = true; state.error ||= 'Trình duyệt không trả dữ liệu video. Kiểm tra camera, quyền ghi và khóa màn hình.'; }
              local.actualStoppedAt = Date.now(); local.final = !state.failed; local.error = state.failed ? (state.error || 'Video chưa đầy đủ do lỗi ghi.') : '';
              await updateJob(local.id, { actualStoppedAt: local.actualStoppedAt, final: local.final, error: local.error, capture: local.capture });
            } catch (error) {
              state.failed = true; local.final = false; local.error = `Không lưu được phần cuối: ${error.name || 'StorageError'}: ${error.message}`;
              notify(`${local.error} ${error.message}`);
            } finally {
              if (active === state) { active = null; onState(false); }
              resolve();
            }
            if (discarded.has(local.id)) return;
            await api('record/ack', { id: local.id, state: state.failed ? 'failed' : 'stopped', error: local.error }).catch(() => {});
            await uploads.get(local.id); if (local.final) await pump(local.id); await refresh();
          };
        });
        rec.onerror = event => { state.failed = true; state.error = `${event.error?.name || 'MediaRecorderError'}: ${event.error?.message || 'Trình duyệt dừng ghi hình'}`; notify(state.error); if (rec.state !== 'inactive') rec.stop(); };
        rec.start(2000); local.actualStartedAt = Date.now(); await updateJob(local.id, { actualStartedAt: local.actualStartedAt, mime: local.mime, capture: local.capture });
        await api('record/ack', { id: local.id, state: 'recording', actualStartedAt: local.actualStartedAt, capture: local.capture }).catch(() => {});
      } catch (error) {
        state.failed = true;
        if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
        if (active === state) { active = null; onState(false); }
        local.error = error.message; await putJob(local).catch(() => {}); await refresh();
        await api('record/ack', { id: local.id, state: 'failed', error: error.message }).catch(() => {});
      }
    }, Math.max(0, delay));
  }
  async function stop(take, delay = 0) {
    const state = active; if (!state || (take && state.take !== take)) return;
    if (!state.recorder) {
      clearTimeout(state.timer); active = null; onState(false);
      const job = await getJob(state.id); job.error = 'Đã hủy trong thời gian đếm ngược.'; await putJob(job);
      await api('record/ack', { id: state.id, state: 'failed', error: job.error }).catch(() => {}); await refresh(); return;
    }
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    if (state.recorder.state !== 'inactive') state.recorder.stop();
    await state.complete;
  }
  async function discard(ids) {
    for (const id of ids) { discarded.add(id); retries.delete(id); }
    const state = active;
    if (state && ids.includes(state.id)) {
      clearTimeout(state.timer); state.failed = true;
      if (state.recorder) { if (state.recorder.state !== 'inactive') state.recorder.stop(); await state.complete; await state.writing; }
      else { active = null; onState(false); }
    }
    for (const id of ids) await store.remove(id);
    await refresh();
  }
  async function retainRoomTake(room, take) {
    const old = (await jobs()).filter(job => job.room === room && job.take !== take);
    if (old.length) await discard(old.map(job => job.id));
  }
  async function reconcile(room, take, ids) {
    const allowed = new Set(ids);
    const old = (await jobs()).filter(job => job.room === room && (job.take !== take || !allowed.has(job.id)));
    if (old.length) await discard(old.map(job => job.id));
  }
  window.addEventListener('online', async () => { for (const job of await jobs()) if (job.final && !job.uploaded) pump(job.id); });
  setInterval(async () => { for (const job of await jobs()) if (!job.uploaded && (job.final || active?.id === job.id)) pump(job.id); }, 5000);
  window.addEventListener('beforeunload', e => { if (active || uploads.size || store.hasPendingVolatile()) { e.preventDefault(); e.returnValue = ''; } });
  return { start, stop, refresh, discard, retainRoomTake, reconcile, get active() { return Boolean(active); } };
}
