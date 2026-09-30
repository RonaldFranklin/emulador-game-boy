-- One native cartridge save per account/game. No save-state or imported-file API.
CREATE TABLE game_saves (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  data bytea NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 1048576 AND size = octet_length(data)),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, game_id),
  CHECK (sha256 = encode(sha256(data), 'hex'))
);
CREATE INDEX game_saves_game_id_idx ON game_saves(game_id);

-- Raw lease UUIDs never enter the database. Revoking a session releases its leases.
CREATE TABLE play_leases (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  session_token_hash char(64) NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, game_id)
);
CREATE INDEX play_leases_session_idx ON play_leases(session_token_hash);
CREATE INDEX play_leases_expiration_idx ON play_leases(expires_at);
