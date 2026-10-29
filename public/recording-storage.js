// ArrayBuffers avoid relying on browser-specific Blob persistence. Each chunk and
// its counter commit together, so recovery never advertises an unwritten chunk.
export function createLocalStore({ indexedDB = globalThis.indexedDB, maxMemoryBytes = 64 * 1024 * 1024, warn = () => {} } = {}) {
  const memoryJobs = new Map(), memoryChunks = new Map(), cache = new Map(), released = new Set(); let memoryBytes = 0;
  async function transaction(stores, mode, action) {
    const db = await new Promise((resolve, reject) => {
      if (!indexedDB) return reject(Error('IndexedDB không khả dụng'));
      const request = indexedDB.open('camroom-recordings', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('jobs', { keyPath: 'id' }); request.result.createObjectStore('chunks', { keyPath: 'key' }); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('Bộ nhớ đang bị tab khác khóa'));
    });
    try { return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode); let value;
      action(tx, result => { value = result; });
      tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('Giao dịch bộ nhớ bị hủy'));
    }); } finally { db.close(); }
  }
  function fallback(job, error) {
    if (!memoryJobs.has(job.id)) warn(`Bộ nhớ thiết bị lỗi (${error?.name || 'StorageError'}: ${error?.message || ''}). Đang giữ tạm trong RAM và gửi lên server; giữ trang mở đến khi lưu xong.`);
    const next = { ...job, volatile: true }; memoryJobs.set(job.id, next); cache.set(job.id, next); return next;
  }
  async function get(id) {
    if (memoryJobs.has(id)) return memoryJobs.get(id);
    try { const value = await transaction(['jobs'], 'readonly', (tx, done) => { tx.objectStore('jobs').get(id).onsuccess = e => done(e.target.result); }); if (value) cache.set(id, value); return value; }
    catch (error) { if (cache.has(id)) return fallback(cache.get(id), error); throw error; }
  }
  async function put(job) {
    cache.set(job.id, { ...job });
    if (memoryJobs.has(job.id)) { memoryJobs.set(job.id, { ...job, volatile: true }); return; }
    try { await transaction(['jobs'], 'readwrite', tx => tx.objectStore('jobs').put(job)); }
    catch (error) { fallback(job, error); }
  }
  async function append(job, blob) {
    const data = await blob.arrayBuffer(), key = `${job.id}:${job.count}`;
    const next = { ...job, ...(released.has(job.id) ? { localIncomplete: true } : {}), count: job.count + 1, bytes: job.bytes + data.byteLength };
    if (!memoryJobs.has(job.id)) {
      try {
        await transaction(['jobs', 'chunks'], 'readwrite', tx => { tx.objectStore('chunks').put({ key, data }); tx.objectStore('jobs').put(next); });
        Object.assign(job, next); cache.set(job.id, { ...next }); return;
      } catch (error) { fallback(job, error); }
    }
    if (memoryBytes + data.byteLength > maxMemoryBytes) throw Error('Bộ nhớ tạm đã đầy (64 MB). Mạng upload quá chậm; dừng quay và chờ lưu.');
    memoryChunks.set(key, data); memoryBytes += data.byteLength;
    Object.assign(job, next, { volatile: true }); memoryJobs.set(job.id, { ...job }); cache.set(job.id, { ...job });
  }
  async function chunk(id, index) {
    const key = `${id}:${index}`, data = memoryChunks.get(key);
    if (data) return { blob: new Blob([data]) };
    const saved = await transaction(['chunks'], 'readonly', (tx, done) => { tx.objectStore('chunks').get(key).onsuccess = e => done(e.target.result); });
    return saved ? { blob: saved.blob || new Blob([saved.data]) } : null;
  }
  async function patch(id, values) {
    if (cache.has(id)) Object.assign(cache.get(id), values);
    if (memoryJobs.has(id)) { Object.assign(memoryJobs.get(id), values); return; }
    // Read-modify-write inside one transaction; never overwrite a newer chunk count.
    try { await transaction(['jobs'], 'readwrite', tx => { const store = tx.objectStore('jobs'); store.get(id).onsuccess = e => store.put({ ...e.target.result, ...values }); }); }
    catch (error) { const job = await get(id); fallback({ ...job, ...values }, error); }
  }
  function acknowledge(id, next) {
    for (const [key, data] of memoryChunks) if (key.startsWith(`${id}:`) && Number(key.slice(id.length + 1)) < next) {
      memoryChunks.delete(key); memoryBytes -= data.byteLength;
      released.add(id); const job = memoryJobs.get(id); if (job) job.localIncomplete = true;
    }
  }
  async function list() {
    let saved = [];
    try { saved = await transaction(['jobs'], 'readonly', (tx, done) => { tx.objectStore('jobs').getAll().onsuccess = e => done(e.target.result); }); } catch {}
    return [...new Map([...saved, ...memoryJobs.values()].map(job => [job.id, job])).values()];
  }
  return { get, put, append, patch, chunk, acknowledge, list, hasPendingVolatile: () => [...memoryJobs.values()].some(job => !job.uploaded) };
}
