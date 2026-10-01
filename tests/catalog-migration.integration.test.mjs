import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import argon2 from 'argon2';
import pg from 'pg';
import { databaseConfig } from '../backend/dist/config.js';
import { migrate } from '../backend/dist/database/migrations.js';
import { syntheticCover, syntheticRom } from './helpers/catalog-fixtures.mjs';

test('migração 002 → 003 preserva catálogo GB populado, identidade, arquivos, contas e sessões', async () => {
  const database = `emulador_test_${randomBytes(10).toString('hex')}`;
  const admin = new pg.Pool(databaseConfig());
  let ownsDatabase = false;
  let pool;
  let directory;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    ownsDatabase = true;
    pool = new pg.Pool({ ...databaseConfig(), database });
    directory = await mkdtemp(join(tmpdir(), 'emulador-migration-gb-'));
    await mkdir(join(directory, 'roms'));
    await mkdir(join(directory, 'covers'));
    await pool.query(`CREATE TABLE schema_migrations (
      name text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    // Reconstruct the deployed pre-GBA schema from its unchanged migration files,
    // retaining their exact checksums for the normal runner's upgrade checks.
    for (const name of ['001-auth.sql', '002-catalog.sql']) {
      const sql = await readFile(new URL(`../backend/migrations/${name}`, import.meta.url), 'utf8');
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)',
        [name, createHash('sha256').update(sql).digest('hex')]);
    }
    assert.equal((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='games' AND column_name='console'")).rowCount, 0);
    const userId = randomUUID();
    const passwordHash = await argon2.hash(randomBytes(24).toString('base64url'), {
      type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1,
    });
    await pool.query("INSERT INTO users(id, username, password_hash, role) VALUES ($1, 'migration_master', $2, 'MASTER')", [userId, passwordHash]);
    await pool.query("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')", [randomBytes(32).toString('hex'), userId]);

    const files = [];
    for (const [index, active, cgbFlag] of [[1, true, 0], [2, false, 0x80]]) {
      const rom = syntheticRom({ cgbFlag });
      const cover = index === 1 ? await syntheticCover() : null;
      const romKey = `${randomUUID()}.gb`;
      const coverKey = cover ? `${randomUUID()}.png` : null;
      const romPath = join(directory, 'roms', romKey);
      await writeFile(romPath, rom, { flag: 'wx', mode: 0o600 });
      files.push({ path: romPath, bytes: rom });
      if (cover) {
        const coverPath = join(directory, 'covers', coverKey);
        await writeFile(coverPath, cover, { flag: 'wx', mode: 0o600 });
        files.push({ path: coverPath, bytes: cover });
      }
      await pool.query(`INSERT INTO games (
        id, name, active, rom_key, rom_sha256, rom_size, cartridge_type, cgb_flag,
        cover_key, cover_sha256, cover_size, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [
        randomUUID(), `GB anterior ${index}`, active, romKey,
        createHash('sha256').update(rom).digest('hex'), rom.length, rom[0x147], cgbFlag,
        coverKey, cover ? createHash('sha256').update(cover).digest('hex') : null, cover?.length ?? null,
        '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z',
      ]);
    }
    const oldGames = (await pool.query('SELECT * FROM games ORDER BY id')).rows;
    const oldUsers = (await pool.query('SELECT * FROM users ORDER BY id')).rows;
    const oldSessions = (await pool.query('SELECT * FROM sessions ORDER BY token_hash')).rows;
    const oldMigrations = (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows;

    await migrate(pool);
    const newGames = (await pool.query('SELECT * FROM games ORDER BY id')).rows;
    assert.equal(newGames.length, 2);
    assert.ok(newGames.every((game) => game.console === 'GB'));
    assert.deepEqual(newGames.map(({ console: detectedConsole, ...original }) => original), oldGames);
    assert.deepEqual((await pool.query('SELECT * FROM users ORDER BY id')).rows, oldUsers);
    assert.deepEqual((await pool.query('SELECT * FROM sessions ORDER BY token_hash')).rows, oldSessions);
    const migrations = (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
    assert.deepEqual(migrations.slice(0, 2), oldMigrations);
    assert.equal(migrations.length, 6);
    assert.equal(migrations[2].name, '003-catalog-consoles.sql');
    assert.equal(migrations[3].name, '004-play-saves.sql');
    assert.equal(migrations[4].name, '005-login-security.sql');
    assert.equal(migrations[5].name, '006-save-states.sql');
    for (const file of files) assert.deepEqual(await readFile(file.path), file.bytes);
    await assert.rejects(pool.query("UPDATE games SET console='GBA' WHERE id=$1", [newGames[0].id]),
      (error) => error.code === 'P0001');
    await migrate(pool);
    assert.deepEqual((await pool.query('SELECT * FROM games ORDER BY id')).rows, newGames);
    assert.deepEqual((await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows, migrations);
  } finally {
    try {
      if (pool) await pool.end();
      if (ownsDatabase) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    } finally {
      await admin.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
});
