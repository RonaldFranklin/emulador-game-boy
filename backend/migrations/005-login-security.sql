-- Keep the existing persistent buckets; IP failures use their own namespace.
ALTER TABLE login_attempts
  ADD COLUMN failure_times timestamptz[] NOT NULL DEFAULT '{}',
  ADD COLUMN blocked_until timestamptz;
