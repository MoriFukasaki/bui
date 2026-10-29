import '../env.mjs';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { getPool, liveServer, closeDatabase } from '../database.mjs';
import { rawSql } from '@neon/realtime/server';
import { storageClient } from '../recordings.mjs';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
const lines = [], report = text => { lines.push(text); console.log(text); };
const testRoom = `qa-${randomBytes(8).toString('hex')}`, id = randomBytes(16).toString('hex');
let subscription, client;
try {
  const db = getPool(); await db.query('SELECT 1'); report('PASS Postgres: live connection established');
  subscription = await liveServer().subscribe(rawSql('SELECT id, state FROM camroom_recordings WHERE room_code=$1', [testRoom]));
  const seen = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Realtime change timeout after 30s')), 30000);
    subscription.onChange(snapshot => { if (snapshot.data?.some(row => row.id === id && row.state === 'proof-ready')) { clearTimeout(timeout); resolve(); } });
    subscription.onStateChange(state => { if (state.status === 'error') { clearTimeout(timeout); reject(Error(`Realtime subscription failed: ${state.error?.code || 'unknown'}`)); } });
  });
  // Subscribe first, then commit a real database write: the live change must cross Neon's WebSocket.
  await db.query(`INSERT INTO camroom_recordings(id,room_code,take_id,camera_name,slot,state,metadata) VALUES($1,$2,$3,'Synthetic infrastructure proof',1,'proof-ready',$4::jsonb)`, [id, testRoom, testRoom, JSON.stringify({ id, room: testRoom, synthetic: true })]);
  const row = (await db.query('SELECT state FROM camroom_recordings WHERE id=$1', [id])).rows[0]; assert.equal(row.state, 'proof-ready');
  report('PASS Postgres: inserted recording metadata and read back matching row');
  await seen; report('PASS Realtime: subscription received the committed recording row from Neon');
  client = await storageClient(); const key = `camroom/_qa/${testRoom}/service-proof.txt`, data = Buffer.from(`Camroom Neon infrastructure proof ${testRoom}`);
  await client.send(new PutObjectCommand({ Bucket: process.env.NEON_BUCKET, Key: key, Body: data, ContentType: 'text/plain' }));
  const result = await client.send(new GetObjectCommand({ Bucket: process.env.NEON_BUCKET, Key: key }));
  const actual = Buffer.from(await result.Body.transformToByteArray()); assert.deepEqual(actual, data);
  report(`PASS Object Storage: uploaded and downloaded private object; SHA-256 ${createHash('sha256').update(actual).digest('hex')}`);
  report('NEON SERVICES E2E PASS (live Postgres + Object Storage + Realtime; no secrets printed)');
} catch (error) { report(`FAIL Neon service proof: ${error.code || error.name}: ${error.message}`); process.exitCode = 1; }
finally {
  subscription?.unsubscribe(); client?.destroy(); await closeDatabase();
  await mkdir('verification', { recursive: true }); await writeFile('verification/neon-services.txt', lines.join('\n') + '\n');
}
