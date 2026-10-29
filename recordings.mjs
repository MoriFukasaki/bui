import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import './env.mjs';
import { mkdir, readFile, writeFile, rename, stat, readdir, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { Readable } from 'node:stream';

const digest = value => createHash('sha256').update(value).digest('hex');
export const storageConfigured = () => ['AWS_ENDPOINT_URL_S3', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'NEON_BUCKET'].every(key => process.env[key]);
export class RecordingStore {
  constructor({ directory = process.env.RECORDING_DIR || './data/recordings', upload, remove = deleteNeon, onChange = () => {}, onDelete = () => {} } = {}) {
    this.directory = resolve(directory); this.onChange = onChange; this.onDelete = onDelete; this.upload = upload || uploadNeon; this.remove = remove; this.locks = new Map();
  }
  path(id) { if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Mã video không hợp lệ.'); return join(this.directory, id); }
  async save(job) {
    const folder = this.path(job.id); await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'manifest.tmp'), JSON.stringify(job)); await rename(join(folder, 'manifest.tmp'), join(folder, 'manifest.json'));
  }
  async load(id) { return JSON.parse(await readFile(join(this.path(id), 'manifest.json'), 'utf8')); }
  async create(meta) {
    const token = randomBytes(32).toString('hex'), id = randomBytes(16).toString('hex');
    const job = { ...meta, id, tokenHash: digest(token), chunks: [], bytes: 0, state: 'scheduled', createdAt: Date.now(), key: null };
    await this.save(job); await this.onChange(this.public(job)); return { ...this.public(job), token };
  }
  public(job) { const { tokenHash, chunks, ...safe } = job; return safe; }
  captureDetails(value) {
    const result = {};
    for (const key of ['width', 'height', 'frameRate', 'requestedBitrate', 'encoderBitrate']) if (Number.isFinite(value?.[key]) && value[key] > 0 && value[key] <= 100000000) result[key] = value[key];
    return result;
  }
  async authenticated(id, token) {
    let job;
    try { job = await this.load(id); } catch (error) { if (error.code === 'ENOENT') throw Object.assign(Error('Video đã bị xóa hoặc lượt quay đã hết hiệu lực.'), { code: 'RECORDING_GONE' }); throw error; }
    if (job.state === 'deleted') throw Object.assign(Error('Video đã bị xóa.'), { code: 'RECORDING_GONE' });
    if (!token || !timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(job.tokenHash, 'hex'))) throw Error('Không có quyền upload video này.'); return job;
  }
  async locked(id, fn) {
    const previous = this.locks.get(id) || Promise.resolve();
    const work = previous.catch(() => {}).then(fn); this.locks.set(id, work);
    try { return await work; } finally { if (this.locks.get(id) === work) this.locks.delete(id); }
  }
  async update(id, patch) {
    return this.locked(id, async () => { const job = await this.load(id); if (job.state === 'deleted') throw Error('Video đã bị xóa.'); Object.assign(job, patch); await this.save(job); await this.onChange(this.public(job)); return this.public(job); });
  }
  async listRoom(room) {
    const jobs = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
      const job = await this.load(entry.name); if (job.room === room) jobs.push(this.public(job));
    }
    return jobs;
  }
  async delete(recording) {
    return this.locked(recording.id, async () => {
      let job;
      try { job = await this.load(recording.id); } catch (error) { if (error.code !== 'ENOENT') throw error; job = { ...recording }; }
      if (job.room !== recording.room) throw Error('Video không thuộc phòng này.');
      // Tombstone before cloud deletion; every late chunk/complete now fails closed.
      job.state = 'deleted'; await this.save(job); await this.onChange(this.public(job));
      await this.remove(job);
      // path() only accepts a 32-hex child directory beneath the configured spool.
      await rm(this.path(job.id), { recursive: true, force: true });
      await this.onDelete(this.public(job));
    });
  }
  async chunk(id, token, index, bytes) {
    return this.locked(id, async () => {
      const job = await this.authenticated(id, token);
      if (!Number.isInteger(index) || index < 0 || index > 100000) throw Error('Thứ tự chunk không hợp lệ.');
      const hash = digest(bytes);
      if (index < job.chunks.length) { if (job.chunks[index].hash !== hash) throw Error('Chunk đã tồn tại với nội dung khác.'); return { next: job.chunks.length }; }
      if (job.state === 'uploaded' || job.finalCount !== undefined || index !== job.chunks.length) throw Error('Chunk sai thứ tự hoặc video đã đóng.');
      if (job.bytes + bytes.length > Number(process.env.MAX_RECORDING_BYTES || 2147483648)) throw Error('Video vượt dung lượng cho phép.');
      const folder = this.path(id), file = join(folder, `${index}.bin`);
      await writeFile(`${file}.tmp`, bytes); await rename(`${file}.tmp`, file);
      job.chunks.push({ hash, size: bytes.length }); job.bytes += bytes.length; job.state = 'receiving';
      await this.save(job); await this.onChange(this.public(job)); return { next: job.chunks.length };
    });
  }
  async complete(id, token, details) {
    return this.locked(id, async () => {
      const job = await this.authenticated(id, token);
      if (job.state === 'uploaded') return this.public(job);
      if (!Number.isInteger(details.count) || details.count < 1 || job.chunks.length !== details.count || !job.bytes) throw Error('Chưa nhận đủ dữ liệu video.');
      if (typeof details.mime !== 'string' || details.mime.length > 200 || !/^video\/(webm|mp4)(;[a-zA-Z0-9=.," _-]+)?$/.test(details.mime)) throw Error('Định dạng video không hợp lệ.');
      if ((details.actualStartedAt !== undefined || details.actualStoppedAt !== undefined) &&
          (!Number.isFinite(details.actualStartedAt) || !Number.isFinite(details.actualStoppedAt) || details.actualStartedAt < 0 || details.actualStoppedAt < details.actualStartedAt)) throw Error('Thời gian video không hợp lệ.');
      job.mime = details.mime; job.finalCount = details.count; job.actualStartedAt = details.actualStartedAt; job.actualStoppedAt = details.actualStoppedAt;
      if (details.capture) job.capture = this.captureDetails(details.capture);
      job.deviceClockOffsetMs = Number.isFinite(details.clockOffset) ? details.clockOffset : 0;
      job.actualStartedServerAt = Number(job.actualStartedAt) + job.deviceClockOffsetMs;
      job.actualStoppedServerAt = Number(job.actualStoppedAt) + job.deviceClockOffsetMs;
      job.key = `camroom/${job.room}/${job.take}/cam-${String(job.slot).padStart(2, '0')}-${job.id}.${job.mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
      job.state = 'uploading'; await this.save(job); await this.onChange(this.public(job));
      const directory = this.path(id);
      try {
        const source = Readable.from((async function* () {
          for (let i = 0; i < job.chunks.length; i++) {
            const file = join(directory, `${i}.bin`); if ((await stat(file)).size !== job.chunks[i].size) throw Error('Dữ liệu trên đĩa không đầy đủ.');
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(file)) { hash.update(chunk); yield chunk; }
            if (hash.digest('hex') !== job.chunks[i].hash) throw Error('Dữ liệu trên đĩa đã bị thay đổi.');
          }
        })());
        await this.upload(job, source);
        job.state = 'uploaded'; job.uploadedAt = Date.now(); job.error = null;
        await this.save(job); await this.onChange(this.public(job));
        // Retain the spool as recovery material. Operators can archive/remove it after confirming the bucket.
        return this.public(job);
      } catch (error) {
        job.state = 'upload-failed'; job.error = 'Không tải được lên Neon. Kiểm tra cấu hình bucket/mạng rồi thử lại.';
        await this.save(job); await this.onChange(this.public(job)); throw Error(job.error);
      }
    });
  }
}
export async function storageClient() {
  const { S3Client } = await import('@aws-sdk/client-s3');
  return new S3Client({ endpoint: process.env.AWS_ENDPOINT_URL_S3, region: process.env.AWS_REGION, forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });
}
export async function downloadURL(job) {
  const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')]);
  const client = await storageClient();
  try { return await getSignedUrl(client, new GetObjectCommand({ Bucket: process.env.NEON_BUCKET, Key: job.key, ResponseContentDisposition: `attachment; filename="cam-${job.slot}-${job.take}.${job.mime.startsWith('video/mp4') ? 'mp4' : 'webm'}"` }), { expiresIn: 300 }); }
  finally { client.destroy(); }
}
export async function openRecording(job) {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await storageClient();
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: process.env.NEON_BUCKET, Key: job.key }));
    return { body: object.Body, size: object.ContentLength, close: () => client.destroy() };
  } catch (error) { client.destroy(); throw error; }
}
async function deleteNeon(job) {
  if (!job.key) return;
  const expected = `camroom/${job.room}/${job.take}/cam-${String(job.slot).padStart(2, '0')}-${job.id}.`;
  if (![`${expected}mp4`, `${expected}webm`].includes(job.key)) throw Error('Đường dẫn video không hợp lệ.');
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3'); const client = await storageClient();
  try { for (const key of [job.key, `${job.key}.json`]) await client.send(new DeleteObjectCommand({ Bucket: process.env.NEON_BUCKET, Key: key })); }
  finally { client.destroy(); }
}
async function uploadNeon(job, source) {
  if (!storageConfigured()) throw Error('Chưa cấu hình Neon.');
  const { Upload } = await import('@aws-sdk/lib-storage');
  const client = await storageClient();
  try {
    await new Upload({ client, queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false, params: {
      Bucket: process.env.NEON_BUCKET, Key: job.key, Body: source, ContentType: job.mime,
      Metadata: { 'take-id': job.take, 'camera-id': job.peerId, 'scheduled-start': String(job.scheduledAt) },
    } }).done();
    // A sidecar records each camera's actual timing and capture settings for post-production.
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { tokenHash, chunks, ...metadata } = job;
    await client.send(new PutObjectCommand({ Bucket: process.env.NEON_BUCKET, Key: `${job.key}.json`, Body: JSON.stringify({ ...metadata, state: 'uploaded' }), ContentType: 'application/json' }));
  } finally { client.destroy(); }
}
