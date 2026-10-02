-- Expiry and a bounded registry for security buckets; never truncate active blocks.
ALTER TABLE login_attempts ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '1 day');
UPDATE login_attempts SET expires_at = GREATEST(window_start + interval '1 day', blocked_until);
CREATE INDEX login_attempts_expires_idx ON login_attempts(expires_at);
CREATE TABLE security_capacity (id boolean PRIMARY KEY DEFAULT true CHECK(id));
INSERT INTO security_capacity DEFAULT VALUES;
ALTER TABLE login_attempts ADD COLUMN scope text NOT NULL DEFAULT 'anonymous' CHECK(scope IN ('anonymous','actor'));
CREATE INDEX login_attempts_scope_idx ON login_attempts(scope);
