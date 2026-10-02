ALTER TABLE login_attempts ADD COLUMN byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count >= 0);
-- Fixed ring: at most 50,000 events, additionally expired after 30 days.
CREATE SEQUENCE security_audit_slot MINVALUE 1 MAXVALUE 50000 CYCLE;
CREATE TABLE security_audit (
 slot integer PRIMARY KEY DEFAULT nextval('security_audit_slot'),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 event varchar(48) NOT NULL,
 actor uuid,
 target varchar(64),
 game uuid,
 state_slot smallint CHECK(state_slot BETWEEN 0 AND 3),
 outcome integer NOT NULL CHECK(outcome BETWEEN 100 AND 599),
 correlation uuid NOT NULL,
 origin_hash char(64),
 dropped integer NOT NULL DEFAULT 0 CHECK(dropped >= 0)
);
ALTER SEQUENCE security_audit_slot OWNED BY security_audit.slot;
CREATE INDEX security_audit_time_idx ON security_audit(occurred_at);
CREATE INDEX security_audit_actor_time_idx ON security_audit(actor,occurred_at);
