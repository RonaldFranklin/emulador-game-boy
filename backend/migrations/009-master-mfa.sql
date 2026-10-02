ALTER TABLE users ADD COLUMN mfa_secret text,
 ADD COLUMN mfa_last_step bigint NOT NULL DEFAULT -1,
 ADD COLUMN mfa_recovery_hashes text[] NOT NULL DEFAULT '{}',
 ADD COLUMN mfa_pending_secret text,
 ADD COLUMN mfa_pending_until timestamptz,
 ADD COLUMN mfa_pending_session char(64);
ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz,
 ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX sessions_last_seen_idx ON sessions(last_seen_at);
