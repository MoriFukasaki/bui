import './env.mjs';
import pg from 'pg';
import { createRealtime, rawSql } from '@neon/realtime/server';
export const databaseEnabled = () => !process.env.CAMROOM_OFFLINE && Boolean(process.env.DATABASE_URL);
let pool, realtime;
const secureURL = value => { const url = new URL(value); url.searchParams.set('sslmode', 'verify-full'); return url.toString(); };
export function getPool(unpooled = false) {
  if (!databaseEnabled()) throw Error('Postgres chưa được cấu hình.');
  if (unpooled) return new pg.Pool({ connectionString: secureURL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL), max: 1, connectionTimeoutMillis: 15000 });
  if (!pool) {
    pool = new pg.Pool({ connectionString: secureURL(process.env.DATABASE_URL), max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
    pool.on('error', () => console.error('Postgres connection lost; subsequent requests will reconnect.'));
  }
  return pool;
}
export async function persistRecording(job) {
  if (!databaseEnabled()) return;
  // Metadata only: media bytes live in Object Storage, credentials stay in the local spool manifest.
  await getPool().query(`INSERT INTO camroom_recordings (id, room_code, take_id, camera_name, slot, state, object_key, bytes, metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state, object_key=EXCLUDED.object_key,
      bytes=EXCLUDED.bytes, metadata=EXCLUDED.metadata, updated_at=now()`,
  [job.id, job.room, job.take, job.name, job.slot, job.state, job.key, job.bytes, JSON.stringify(job)]);
}
export async function listRecordings(roomCode, includeDeleted = false) {
  if (!databaseEnabled()) return [];
  return (await getPool().query("SELECT metadata FROM camroom_recordings WHERE room_code=$1 AND ($2 OR state <> 'deleted') ORDER BY created_at DESC", [roomCode, includeDeleted])).rows.map(r => r.metadata);
}
export async function saveRoom(room) {
  if (!databaseEnabled()) return;
  const result = await getPool().query('INSERT INTO camroom_rooms(code,max_cameras,owner_token_hash,latest_take) VALUES($1,$2,$3,$4) ON CONFLICT(code) DO UPDATE SET latest_take=EXCLUDED.latest_take WHERE camroom_rooms.owner_token_hash=EXCLUDED.owner_token_hash', [room.code, room.maxCameras, room.ownerHash, room.latestTake || null]);
  if (!result.rowCount) throw Error('Không có quyền cập nhật phòng.');
}
export async function loadRoom(code) {
  if (!databaseEnabled()) return null;
  const row = (await getPool().query('SELECT code,max_cameras,owner_token_hash,latest_take FROM camroom_rooms WHERE code=$1', [code])).rows[0];
  return row ? { code: row.code, maxCameras: row.max_cameras, ownerHash: row.owner_token_hash, latestTake: row.latest_take } : null;
}
export async function deleteRecordingRow(id, room) {
  if (databaseEnabled()) await getPool().query('DELETE FROM camroom_recordings WHERE id=$1 AND room_code=$2', [id, room]);
}
export function liveServer() {
  if (!process.env.NEON_REALTIME_URL || !process.env.NEON_REALTIME_SECRET) throw Error('Realtime chưa được cấu hình.');
  if (!realtime) realtime = createRealtime({ url: process.env.NEON_REALTIME_URL, secret: process.env.NEON_REALTIME_SECRET, db: decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)) });
  return realtime;
}
export async function subscribeRecordings(roomCode, onChange, onState = () => {}) {
  const subscription = await liveServer().subscribe(rawSql('SELECT id, metadata FROM camroom_recordings WHERE room_code = $1 ORDER BY created_at DESC LIMIT 1000', [roomCode]));
  subscription.onChange(snapshot => { if (snapshot.data) onChange(snapshot.data.map(row => row.metadata)); onState(snapshot); });
  subscription.onStateChange(onState);
  return () => subscription.unsubscribe();
}
export async function closeDatabase() { realtime?.close(); realtime = null; if (pool) { await pool.end(); pool = null; } }
