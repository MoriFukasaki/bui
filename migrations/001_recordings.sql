CREATE TABLE IF NOT EXISTS camroom_recordings (
  id text PRIMARY KEY,
  room_code text NOT NULL,
  take_id text NOT NULL,
  camera_name text NOT NULL,
  slot integer NOT NULL CHECK (slot BETWEEN 1 AND 10),
  state text NOT NULL,
  object_key text,
  bytes bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS camroom_recordings_room_created_idx ON camroom_recordings (room_code, created_at DESC);
