-- The operator provisions the LOGIN role/secret separately. Isolated legacy
-- restore/test databases may omit this cluster-level role; never create roles
-- or embed credentials in an application migration.
DO $$ BEGIN
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='emulador_runtime') THEN
  GRANT USAGE ON SCHEMA public TO emulador_runtime;
  GRANT SELECT, INSERT, UPDATE, DELETE ON
   users, sessions, login_attempts, games, game_saves, play_leases,
   save_states, save_resets, security_capacity, security_audit TO emulador_runtime;
  GRANT SELECT ON schema_migrations TO emulador_runtime;
  GRANT USAGE ON SEQUENCE security_audit_slot TO emulador_runtime;
 END IF;
END $$;
