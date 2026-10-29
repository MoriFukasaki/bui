import '../env.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getPool, closeDatabase } from '../database.mjs';
import { storageClient } from '../recordings.mjs';
import { GetObjectCommand } from '@aws-sdk/client-s3';
const room = process.argv[2];
if (!/^[A-F0-9]{12}$/.test(room || '')) throw Error('Pass the synthetic QA room code.');
const lines = [], report = text => { console.log(text); lines.push(text); };
const client = await storageClient();
try {
  const response = await fetch('http://localhost:3000/'); assert.equal(response.status, 200); report('PASS app: running HTTP server returned 200');
  const rows = (await getPool().query("SELECT metadata FROM camroom_recordings WHERE room_code=$1 AND state='uploaded' ORDER BY slot", [room])).rows;
  assert.equal(rows.length, 3, 'expected 3 uploaded camera files');
  assert.equal(new Set(rows.map(r => r.metadata.take)).size, 1); assert.equal(new Set(rows.map(r => r.metadata.key)).size, 3);
  await mkdir('verification', { recursive: true });
  const starts = [];
  for (const { metadata: job } of rows) {
    assert.equal(job.captureState, 'stopped');
    const manifest = JSON.parse(await readFile(join(resolve(process.env.RECORDING_DIR || './data/recordings'), job.id, 'manifest.json'), 'utf8'));
    const localHash = createHash('sha256');
    for (let i = 0; i < manifest.chunks.length; i++) localHash.update(await readFile(join(resolve(process.env.RECORDING_DIR || './data/recordings'), job.id, `${i}.bin`)));
    const result = await client.send(new GetObjectCommand({ Bucket: process.env.NEON_BUCKET, Key: job.key }));
    const bytes = Buffer.from(await result.Body.transformToByteArray()), hash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash, localHash.digest('hex')); assert.equal(bytes.length, job.bytes);
    assert.ok(bytes.includes(Buffer.from('ftyp')) || job.mime.startsWith('video/webm'));
    const sidecar = await client.send(new GetObjectCommand({ Bucket: process.env.NEON_BUCKET, Key: `${job.key}.json` }));
    const timing = JSON.parse(await sidecar.Body.transformToString()); assert.ok(timing.actualStoppedAt > timing.actualStartedAt);
    starts.push(timing.actualStartedAt);
    await writeFile(`verification/camroom-cam${job.slot}.${job.mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`, bytes);
    report(`PASS camera ${job.slot}: ${job.bytes} bytes; private bucket download matches local recording SHA-256 ${hash}`);
  }
  report(`PASS one-click recording: 3 distinct videos, one take; observed start spread ${Math.max(...starts) - Math.min(...starts)} ms on this synthetic run`);
  report('MULTICAMERA E2E PASS (3 browser-generated cameras → recording → chunk upload → Neon bucket → verified download + Postgres metadata)');
} catch (error) { report(`FAIL video proof: ${error.code || error.name}: ${error.message}`); process.exitCode = 1; }
finally { client.destroy(); await closeDatabase(); await writeFile('verification/multicamera.txt', lines.join('\n') + '\n'); }
