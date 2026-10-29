CREATE TABLE IF NOT EXISTS camroom_rooms (
  code text PRIMARY KEY,
  max_cameras integer NOT NULL CHECK (max_cameras BETWEEN 1 AND 10),
  owner_token_hash text NOT NULL,
  latest_take text,
  created_at timestamptz NOT NULL DEFAULT now()
);
