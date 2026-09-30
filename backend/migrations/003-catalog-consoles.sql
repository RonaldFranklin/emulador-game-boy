-- Existing games remain GB without rewriting identifiers, files, hashes or dates.
ALTER TABLE games ADD COLUMN console text NOT NULL DEFAULT 'GB';
ALTER TABLE games ALTER COLUMN console DROP DEFAULT;
ALTER TABLE games ADD CONSTRAINT games_console_check CHECK (console IN ('GB', 'GBA'));

ALTER TABLE games ALTER COLUMN cartridge_type DROP NOT NULL;
ALTER TABLE games ALTER COLUMN cgb_flag DROP NOT NULL;
ALTER TABLE games DROP CONSTRAINT games_rom_key_check;
ALTER TABLE games DROP CONSTRAINT games_rom_size_check;
ALTER TABLE games ADD CONSTRAINT games_rom_console_check CHECK (
  (console = 'GB'
    AND rom_key ~ '^[0-9a-f-]{36}\.gb$'
    AND rom_size BETWEEN 32768 AND 8388608
    AND cartridge_type IS NOT NULL AND cgb_flag IS NOT NULL)
  OR
  (console = 'GBA'
    AND rom_key ~ '^[0-9a-f-]{36}\.gba$'
    AND rom_size BETWEEN 192 AND 33554432
    AND cartridge_type IS NULL AND cgb_flag IS NULL)
);

CREATE OR REPLACE FUNCTION preserve_game_rom() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.console IS DISTINCT FROM OLD.console
     OR NEW.rom_key IS DISTINCT FROM OLD.rom_key OR NEW.rom_sha256 IS DISTINCT FROM OLD.rom_sha256
     OR NEW.rom_size IS DISTINCT FROM OLD.rom_size OR NEW.cartridge_type IS DISTINCT FROM OLD.cartridge_type
     OR NEW.cgb_flag IS DISTINCT FROM OLD.cgb_flag THEN
    RAISE EXCEPTION 'Game identity, console and ROM are immutable';
  END IF;
  RETURN NEW;
END;
$$;
