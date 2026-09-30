CREATE TABLE games (
  id uuid PRIMARY KEY,
  name varchar(120) NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT false,
  rom_key text NOT NULL UNIQUE CHECK (rom_key ~ '^[0-9a-f-]{36}\.gb$'),
  rom_sha256 char(64) NOT NULL UNIQUE CHECK (rom_sha256 ~ '^[0-9a-f]{64}$'),
  rom_size integer NOT NULL CHECK (rom_size BETWEEN 32768 AND 8388608),
  cartridge_type integer NOT NULL CHECK (cartridge_type BETWEEN 0 AND 255),
  cgb_flag integer NOT NULL CHECK (cgb_flag BETWEEN 0 AND 128),
  cover_key text UNIQUE CHECK (cover_key ~ '^[0-9a-f-]{36}\.png$'),
  cover_sha256 char(64) CHECK (cover_sha256 ~ '^[0-9a-f]{64}$'),
  cover_size integer CHECK (cover_size BETWEEN 1 AND 2097152),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (cover_key IS NULL AND cover_sha256 IS NULL AND cover_size IS NULL) OR
    (cover_key IS NOT NULL AND cover_sha256 IS NOT NULL AND cover_size IS NOT NULL)
  )
);
CREATE INDEX games_active_name_idx ON games(active, name, id);

CREATE FUNCTION preserve_game_rom() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.rom_key IS DISTINCT FROM OLD.rom_key
     OR NEW.rom_sha256 IS DISTINCT FROM OLD.rom_sha256 OR NEW.rom_size IS DISTINCT FROM OLD.rom_size
     OR NEW.cartridge_type IS DISTINCT FROM OLD.cartridge_type OR NEW.cgb_flag IS DISTINCT FROM OLD.cgb_flag THEN
    RAISE EXCEPTION 'Game identity and ROM are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER games_preserve_rom BEFORE UPDATE ON games
  FOR EACH ROW EXECUTE FUNCTION preserve_game_rom();
