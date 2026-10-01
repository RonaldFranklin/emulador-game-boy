-- Independent state slots; NULL payload is a versioned tombstone (no ABA).
CREATE TABLE save_states (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 game_id uuid NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
 slot smallint NOT NULL CHECK(slot BETWEEN 0 AND 3),
 version integer NOT NULL CHECK(version > 0),
 label varchar(80) NOT NULL DEFAULT '',
 console varchar(3) NOT NULL CHECK(console IN ('GB','GBA')),
 rom_sha256 char(64) NOT NULL,
 core_id varchar(100) NOT NULL,
 format integer NOT NULL CHECK(format=1),
 data bytea,
 native bytea,
 sha256 char(64),
 native_sha256 char(64),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,game_id,slot),
 CHECK((data IS NULL AND native IS NULL AND sha256 IS NULL AND native_sha256 IS NULL) OR
   (data IS NOT NULL AND native IS NOT NULL AND sha256 IS NOT NULL AND native_sha256 IS NOT NULL AND
    octet_length(data) BETWEEN 1 AND 524288 AND octet_length(native)<=1048576 AND
    sha256=encode(sha256(data),'hex') AND native_sha256=encode(sha256(native),'hex')))
);
CREATE TABLE save_resets (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 game_id uuid NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
 epoch uuid NOT NULL,
 deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,game_id)
);
