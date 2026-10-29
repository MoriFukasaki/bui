const openDB = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('camroom-recordings', 1);
  request.onupgradeneeded = () => { request.result.createObjectStore('jobs', { keyPath: 'id' }); request.result.createObjectStore('chunks', { keyPath: 'key' }); };
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
async function dbRequest(store, mode, action) {
  const db = await openDB();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode), request = action(tx.objectStore(store)); let result;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('Không lưu được dữ liệu trên điện thoại.'));
  }); } finally { db.close(); }
}
const putJob = job => dbRequest('jobs', 'readwrite', store => store.put(job));
const getJob = id => dbRequest('jobs', 'readonly', store => store.get(id));
async function updateJob(id, patch) {
  const db = await openDB();
  try { await new Promise((resolve, reject) => {
    const tx = db.transaction('jobs', 'readwrite'), store = tx.objectStore('jobs'), request = store.get(id);
    request.onsuccess = () => store.put({ ...request.result, ...patch });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
const jobs = () => dbRequest('jobs', 'readonly', store => store.getAll());
const getChunk = (id, index) => dbRequest('chunks', 'readonly', store => store.get(`${id}:${index}`));
export const supportedMime = () => {
  if (!globalThis.MediaRecorder) return '';
  return ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type)) || '';
};
export function createRecordingController({ api, getStream, getOptions, onState, notify }) {
  let active = null;
  const uploads = new Map();
  async function uploadRequest(job, suffix, body, type) {
    const response = await fetch(`/api/uploads/${job.id}/${suffix}`, { method: 'POST', headers: { Authorization: `Bearer ${job.token}`, 'Content-Type': type }, body });
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
        if (job.final || !active || active.id !== job.id) {
          const download = document.createElement('button'); download.className = 'secondary'; download.textContent = 'Tải bản trên máy';
          download.onclick = async () => {
            try {
              const chunks = []; for (let i = 0; i < job.count; i++) { const chunk = await getChunk(job.id, i); if (chunk) chunks.push(chunk.blob); }
              const url = URL.createObjectURL(new Blob(chunks, { type: job.mime })); const link = document.createElement('a');
              link.href = url; link.download = `cam-${job.slot}-${job.take}${job.final ? '' : '-partial'}.${job.mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`; link.click();
              setTimeout(() => URL.revokeObjectURL(url), 60000);
            } catch (e) { notify(e.message); }
          }; row.append(download);
        }
        if (job.final && !job.uploaded) {
          const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = 'Thử tải lên Neon'; retry.disabled = uploads.has(job.id);
          retry.onclick = () => pump(job.id); row.append(retry);
        }
        root.append(row);
      }
    } catch (error) { notify(`Không truy cập được bộ nhớ video: ${error.message}`); }
  }
  async function pump(id) {
    if (uploads.has(id)) return uploads.get(id);
    const task = (async () => {
      let job;
      try {
        job = await getJob(id); if (!job || job.uploaded) return;
        const status = await fetch(`/api/uploads/${id}/status`, { headers: { Authorization: `Bearer ${job.token}` } });
        if (!status.ok) throw Error('Không truy cập được phiên upload trên server.');
        const remote = await status.json();
        let index = remote.next || 0;
        while (true) {
          job = await getJob(id);
          if (index >= job.count) break;
          const chunk = await getChunk(id, index); if (!chunk) throw Error('Thiếu dữ liệu lưu trên máy.');
          await uploadRequest(job, `chunk?index=${index}`, chunk.blob, 'application/octet-stream'); index++;
        }
        job = await getJob(id);
        if (job.final) {
          await uploadRequest(job, 'complete', JSON.stringify({ count: job.count, mime: job.mime, actualStartedAt: job.actualStartedAt, actualStoppedAt: job.actualStoppedAt, clockOffset: job.clockOffset }), 'application/json');
          job.uploaded = true;
        }
        await updateJob(id, { error: '', ...(job.uploaded ? { uploaded: true } : {}) });
      } catch (error) {
        if (job) await updateJob(id, { error: error.message });
        notify(`Video vẫn được giữ trên thiết bị. ${error.message}`);
      }
    })();
    uploads.set(id, task);
    try { await task; } finally { uploads.delete(id); await refresh(); }
  }
  async function start(job, delay) {
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
        const rec = new MediaRecorder(source, { mimeType: local.mime, videoBitsPerSecond: getOptions().bitrate, audioBitsPerSecond: 128000 });
        state.recorder = rec; local.mime = rec.mimeType || local.mime;
        rec.ondataavailable = e => {
          if (!e.data.size) return;
          state.writing = state.writing.then(async () => {
            for (let offset = 0; offset < e.data.size; offset += 2 * 1024 * 1024) {
              const blob = e.data.slice(offset, offset + 2 * 1024 * 1024);
              await dbRequest('chunks', 'readwrite', store => store.put({ key: `${local.id}:${local.count}`, blob }));
              local.count++; local.bytes += blob.size; await putJob(local);
            }
            // Upload runs independently; local chunks remain available until explicitly cleared by the browser/user.
            pump(local.id); refresh();
          }).catch(error => { state.failed = true; notify(`Lỗi lưu video: ${error.message}`); if (rec.state !== 'inactive') rec.stop(); });
        };
        state.complete = new Promise(resolve => {
          rec.onstop = async () => {
            try {
              await state.writing;
              local.actualStoppedAt = Date.now(); local.final = !state.failed; local.error = state.failed ? 'Video chưa đầy đủ do lỗi bộ nhớ.' : '';
              const latest = await getJob(local.id); await putJob({ ...latest, ...local });
            } catch (error) {
              state.failed = true; local.final = false; local.error = 'Không lưu được phần cuối video trên thiết bị.';
              notify(`${local.error} ${error.message}`);
            } finally {
              if (active === state) { active = null; onState(false); }
              resolve();
            }
            await api('record/ack', { id: local.id, state: state.failed ? 'failed' : 'stopped', error: local.error }).catch(() => {});
            await uploads.get(local.id); if (local.final) await pump(local.id); await refresh();
          };
        });
        rec.onerror = () => { state.failed = true; notify('Trình duyệt báo lỗi ghi hình. Bản đã nhận vẫn được giữ trên máy.'); };
        rec.start(2000); local.actualStartedAt = Date.now(); await putJob(local);
        await api('record/ack', { id: local.id, state: 'recording', actualStartedAt: local.actualStartedAt }).catch(() => {});
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
  window.addEventListener('online', async () => { for (const job of await jobs()) if (job.final && !job.uploaded) pump(job.id); });
  window.addEventListener('beforeunload', e => { if (active || uploads.size) { e.preventDefault(); e.returnValue = ''; } });
  return { start, stop, refresh, get active() { return Boolean(active); } };
}
