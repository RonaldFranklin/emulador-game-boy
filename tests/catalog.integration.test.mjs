import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import argon2 from 'argon2';
import pg from 'pg';
import sharp from 'sharp';
import { databaseConfig } from '../backend/dist/config.js';
import { gbaHeaderChecksum, headerChecksum, syntheticCover, syntheticGbaRom, syntheticRom } from './helpers/catalog-fixtures.mjs';

const databaseName = `emulador_test_${randomBytes(10).toString('hex')}`;
const originalEnvironment = Object.fromEntries(['PGDATABASE', 'APP_ORIGIN', 'CATALOG_STORAGE_DIR'].map((key) => [key, process.env[key]]));
const origin = 'http://127.0.0.1:5173';
const adminPool = new pg.Pool(databaseConfig());
const secret = randomBytes(24).toString('base64url');
let ownsDatabase = false;
let storageDirectory;
let pool;
let app;
let createApp;
let CatalogStorageService;
let CatalogUploadInterceptor;
let baseUrl;
let master;
let player;
let temporary;

function form(fields = {}, files = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, String(value));
  for (const [key, file] of Object.entries(files)) {
    data.append(key, new Blob([file.bytes], { type: file.type ?? 'application/octet-stream' }), file.name);
  }
  return data;
}

async function request(path, { method = 'GET', body, session, headers: overrides = {} } = {}) {
  const headers = { ...overrides };
  if (session) headers.Cookie = session.cookie;
  if (method !== 'GET') {
    if (!Object.hasOwn(headers, 'Origin')) headers.Origin = origin;
    if (!Object.hasOwn(headers, 'X-Requested-With')) headers['X-Requested-With'] = 'XMLHttpRequest';
    if (session && !Object.hasOwn(headers, 'X-CSRF-Token')) headers['X-CSRF-Token'] = session.csrfToken;
  }
  let payload = body;
  if (body !== undefined && !(body instanceof FormData) && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  const bytes = Buffer.from(await response.arrayBuffer());
  const data = bytes.length && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : undefined;
  return { status: response.status, headers: response.headers, data, bytes };
}

async function login(username) {
  const response = await request('/api/auth/login', { method: 'POST', body: { username, password: secret } });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: response.data.csrfToken };
}

function upload(rom = syntheticRom(), { name = 'Cartucho sintético', active = true, cover, filename = 'synthetic.gb' } = {}) {
  return form({ name, active }, {
    rom: { bytes: rom, name: filename },
    ...(cover ? { cover: { bytes: cover, name: 'synthetic.png', type: 'image/png' } } : {}),
  });
}

async function createGame(options = {}) {
  const rom = options.rom ?? syntheticRom();
  const result = await request('/api/games', { method: 'POST', session: master, body: upload(rom, options) });
  assert.equal(result.status, 201);
  assertPublicGame(result.data.game);
  return { game: result.data.game, rom };
}

function assertPublicGame(game) {
  assert.match(game.id, /^[0-9a-f-]{36}$/);
  assert.equal(typeof game.name, 'string');
  assert.ok(['GB', 'GBA'].includes(game.console));
  assert.equal(typeof game.active, 'boolean');
  assert.equal(typeof game.hasCover, 'boolean');
  assert.equal(typeof game.createdAt, 'string');
  assert.equal(typeof game.updatedAt, 'string');
  assert.ok(game.coverUrl === null || game.coverUrl === `/api/games/${game.id}/cover`);
  for (const key of Object.keys(game)) assert.doesNotMatch(key, /rom|sha|storage|_key|path/i);
}

async function filesOnDisk() {
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${relative}/`);
      else files.push(relative);
    }
  }
  await visit(storageDirectory);
  return files.sort();
}

async function startApp() {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}

async function waitUntil(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(20);
  }
  assert.fail(label);
}

describe('Catálogo com PostgreSQL e armazenamento isolados', { concurrency: false }, () => {
  before(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    ownsDatabase = true;
    storageDirectory = await mkdtemp(join(tmpdir(), 'emulador-catalog-api-'));
    process.env.PGDATABASE = databaseName;
    process.env.APP_ORIGIN = origin;
    process.env.CATALOG_STORAGE_DIR = storageDirectory;
    pool = new pg.Pool(databaseConfig());
    const { migrate } = await import('../backend/dist/database/migrations.js');
    await migrate(pool);
    await migrate(pool);
    const hash = await argon2.hash(secret, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    for (const [username, role, mustChange] of [
      ['catalog_master', 'MASTER', false], ['catalog_player', 'JOGADOR', false], ['catalog_temporary', 'JOGADOR', true],
    ]) {
      await pool.query('INSERT INTO users (id, username, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), username, hash, role, mustChange]);
    }
    ({ createApp } = await import('../backend/dist/app.js'));
    ({ CatalogStorageService } = await import('../backend/dist/games/catalog-storage.service.js'));
    ({ CatalogUploadInterceptor } = await import('../backend/dist/games/catalog-upload.interceptor.js'));
    await startApp();
    master = await login('catalog_master');
    player = await login('catalog_player');
    temporary = await login('catalog_temporary');
  });

  after(async () => {
    try {
      if (app) await app.close();
      if (pool) await pool.end();
      if (ownsDatabase) await adminPool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      await adminPool.end();
      if (storageDirectory) await rm(storageDirectory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  test('autenticação e perfil são verificados antes de analisar multipart inválido', async () => {
    assert.equal((await request('/api/games')).status, 401);
    for (const [session, expected] of [[undefined, 401], [player, 403], [temporary, 403]]) {
      for (const [method, path] of [['POST', '/api/games'], ['PATCH', `/api/games/${randomUUID()}`]]) {
        const response = await request(path, {
          method, session, body: 'multipart inválido', headers: { 'Content-Type': 'multipart/form-data' },
        });
        assert.equal(response.status, expected);
      }
    }
    assert.deepEqual((await request('/api/games', { session: master })).data, { games: [] });
    assert.deepEqual(await filesOnDisk(), []);
  });

  test('multipart também exige origem exata, cabeçalho AJAX e CSRF da sessão', async () => {
    for (const headers of [
      { Origin: null }, { Origin: 'https://origem-invalida.example' },
      { 'X-Requested-With': null }, { 'X-CSRF-Token': null },
      { 'X-CSRF-Token': player.csrfToken },
    ]) {
      const response = await request('/api/games', { method: 'POST', session: master, body: upload(), headers });
      assert.equal(response.status, 403);
    }
    assert.equal(Number((await pool.query('SELECT count(*) FROM games')).rows[0].count), 0);
    assert.deepEqual(await filesOnDisk(), []);
  });

  test('valida campos, extensão e estrutura real do cartucho; rejeita arquivos inválidos sem persistir', async () => {
    const badLogo = syntheticRom(); badLogo[0x104] ^= 1;
    const badChecksum = syntheticRom(); badChecksum[0x14d] ^= 1;
    const badSize = syntheticRom(); badSize[0x148] = 1; headerChecksum(badSize);
    const cgbOnly = syntheticRom({ cgbFlag: 0xc0 });
    const invalid = [
      form({ name: 'Sem arquivo', active: true }),
      upload(Buffer.alloc(128)), upload(badLogo), upload(badChecksum), upload(badSize), upload(cgbOnly),
      form({ name: 'Extensão incorreta', active: true }, { rom: { name: 'synthetic.gbc', bytes: syntheticRom() } }),
      form({ name: 'Extensão dupla', active: true }, { rom: { name: 'synthetic.gb.exe', bytes: syntheticRom() } }),
      upload(syntheticRom(), { name: '   ' }),
      upload(syntheticRom(), { name: 'x'.repeat(121) }),
      upload(syntheticRom(), { name: 'Controle\u0000inválido' }),
      form({ name: 'Ativo inválido', active: '1' }, { rom: { name: 'synthetic.gb', bytes: syntheticRom() } }),
      form({ name: 'Campo proibido', active: true, rom_sha256: 'injetado' }, { rom: { name: 'synthetic.gb', bytes: syntheticRom() } }),
    ];
    for (const body of invalid) assert.equal((await request('/api/games', { method: 'POST', session: master, body })).status, 400);
    assert.equal(Number((await pool.query('SELECT count(*) FROM games')).rows[0].count), 0);
    assert.deepEqual(await filesOnDisk(), []);
  });

  test('limites de tamanho rejeitam ROM acima de 8 MiB e capa acima de 2 MiB', async () => {
    assert.equal((await request('/api/games', {
      method: 'POST', session: master, body: upload(Buffer.concat([syntheticRom({ size: 8 * 1024 * 1024 }), Buffer.alloc(1)])),
    })).status, 413);
    assert.equal((await request('/api/games', {
      method: 'POST', session: master, body: upload(syntheticRom(), { cover: Buffer.alloc(2 * 1024 * 1024 + 1) }),
    })).status, 413);
    assert.deepEqual(await filesOnDisk(), []);
  });

  test('capas exigem PNG/JPEG decodificável com limites de dimensões e área', async () => {
    for (const cover of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      await syntheticCover({ width: 2049, height: 1 }),
      await syntheticCover({ width: 2048, height: 2048 }),
    ]) {
      assert.equal((await request('/api/games', {
        method: 'POST', session: master, body: upload(syntheticRom(), { cover }),
      })).status, 400);
    }
    assert.deepEqual(await filesOnDisk(), []);
  });

  test('salva ROM mínima, identifica por UUID e SHA256 e não divulga dados internos', async () => {
    const { game, rom } = await createGame({ name: '  Cartucho sintético A  ' });
    assert.equal(game.name, 'Cartucho sintético A');
    assert.equal(game.console, 'GB');
    assert.equal(game.active, true);
    assert.equal(game.hasCover, false);
    assert.equal(game.coverUrl, null);
    const record = (await pool.query('SELECT * FROM games WHERE id = $1', [game.id])).rows[0];
    assert.match(record.rom_key, /^[0-9a-f-]{36}\.gb$/);
    assert.equal(record.rom_sha256, createHash('sha256').update(rom).digest('hex'));
    assert.equal(record.rom_size, rom.length);
    assert.deepEqual(await readFile(join(storageDirectory, 'roms', record.rom_key)), rom);
    for (const session of [master, player]) {
      const list = await request('/api/games', { session });
      assert.equal(list.status, 200);
      list.data.games.forEach(assertPublicGame);
      assert.ok(list.data.games.some((item) => item.id === game.id));
    }
  });

  test('GBA exige cabeçalho completo, logo, fixos, reservados e complemento válidos', async () => {
    const beforeFiles = await filesOnDisk();
    const beforeCount = (await pool.query('SELECT count(*) FROM games')).rows[0].count;
    const badLogo = syntheticGbaRom(); badLogo[4] ^= 1;
    const badComplement = syntheticGbaRom(); badComplement[0xbd] ^= 1;
    const invalid = [syntheticGbaRom({ size: 192 }).subarray(0, 191), badLogo, badComplement];
    for (const offset of [0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbe, 0xbf]) {
      const bytes = syntheticGbaRom();
      bytes[offset] ^= 1;
      invalid.push(gbaHeaderChecksum(bytes));
    }
    for (const [offset, forbiddenBit] of [[0x9c, 0x01], [0x9e, 0x04]]) {
      const bytes = syntheticGbaRom(); bytes[offset] ^= forbiddenBit; invalid.push(bytes);
    }
    for (const rom of invalid) {
      assert.equal((await request('/api/games', {
        method: 'POST', session: master, body: upload(rom, { filename: 'invalid.gba' }),
      })).status, 400);
    }
    assert.equal((await pool.query('SELECT count(*) FROM games')).rows[0].count, beforeCount);
    assert.deepEqual(await filesOnDisk(), beforeFiles);
  });

  test('console é detectado pelo conteúdo; extensão incoerente e cabeçalho ambíguo são recusados', async () => {
    const beforeFiles = await filesOnDisk();
    const ambiguous = syntheticRom();
    syntheticGbaRom({ size: 192 }).copy(ambiguous, 0);
    for (const [rom, filename] of [
      [syntheticRom(), 'renamed.gba'], [syntheticGbaRom(), 'renamed.gb'],
      [syntheticGbaRom(), 'synthetic.gba.zip'],
      [ambiguous, 'ambiguous.gb'], [ambiguous, 'ambiguous.gba'],
    ]) {
      assert.equal((await request('/api/games', { method: 'POST', session: master, body: upload(rom, { filename }) })).status, 400);
    }
    assert.equal((await request('/api/games', {
      method: 'POST', session: master,
      body: form({ name: 'Console forjado', active: true, console: 'GB' }, { rom: { bytes: syntheticGbaRom(), name: 'synthetic.gba' } }),
    })).status, 400);
    assert.deepEqual(await filesOnDisk(), beforeFiles);
  });

  test('aceita GBA mínimo, tamanho não alinhado e variantes permitidas do logo', async () => {
    for (const size of [192, 193]) {
      const { game, rom } = await createGame({ rom: syntheticGbaRom({ size }), filename: 'synthetic.gba', name: `GBA ${size} bytes` });
      assert.equal(game.console, 'GBA');
      const record = (await pool.query('SELECT * FROM games WHERE id = $1', [game.id])).rows[0];
      assert.equal(record.console, 'GBA');
      assert.equal(record.cartridge_type, null);
      assert.equal(record.cgb_flag, null);
      assert.match(record.rom_key, /^[0-9a-f-]{36}\.gba$/);
      assert.equal(record.rom_size, size);
      assert.equal(record.rom_sha256, createHash('sha256').update(rom).digest('hex'));
      assert.deepEqual(await readFile(join(storageDirectory, 'roms', record.rom_key)), rom);
    }
    const variant = syntheticGbaRom();
    variant[0x9c] ^= 0x84;
    variant[0x9e] ^= 0x03;
    assert.equal((await createGame({ rom: variant, filename: 'variant.GBA', name: 'Logo com bits variáveis' })).game.console, 'GBA');
  });

  test('GBA aceita 32 MiB inclusive e rejeita o byte excedente', async () => {
    const maximum = syntheticGbaRom({ size: 32 * 1024 * 1024 });
    const { game } = await createGame({ rom: maximum, filename: 'maximum.gba', name: 'GBA máximo sintético' });
    assert.equal(game.console, 'GBA');
    assert.equal((await pool.query('SELECT rom_size FROM games WHERE id = $1', [game.id])).rows[0].rom_size, maximum.length);
    const beforeFiles = await filesOnDisk();
    assert.equal((await request('/api/games', {
      method: 'POST', session: master,
      body: upload(Buffer.concat([maximum, Buffer.alloc(1)]), { filename: 'oversize.gba' }),
    })).status, 413);
    assert.deepEqual(await filesOnDisk(), beforeFiles);
  });

  test('duplicatas GBA concorrentes mantêm uma identidade e um arquivo únicos', async () => {
    const rom = syntheticGbaRom();
    const beforeFiles = await filesOnDisk();
    const responses = await Promise.all([1, 2].map((number) => request('/api/games', {
      method: 'POST', session: master,
      body: upload(rom, { filename: `duplicate-${number}.gba`, name: `GBA repetido ${number}` }),
    })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    assert.equal((await pool.query('SELECT id FROM games WHERE rom_sha256 = $1', [createHash('sha256').update(rom).digest('hex')])).rowCount, 1);
    assert.equal((await filesOnDisk()).length, beforeFiles.length + 1);
    assert.equal(responses.find((response) => response.status === 201).data.game.console, 'GBA');
  });

  test('GBA segue autorização, disponibilidade e capa privada; console e ROM permanecem imutáveis', async () => {
    for (const [session, status] of [[undefined, 401], [player, 403], [temporary, 403]]) {
      assert.equal((await request('/api/games', {
        method: 'POST', session, body: upload(syntheticGbaRom(), { filename: 'forbidden.gba' }),
      })).status, status);
    }
    const { game, rom } = await createGame({
      rom: syntheticGbaRom(), filename: 'private.gba', name: 'GBA privado', active: false, cover: await syntheticCover(),
    });
    const original = (await pool.query('SELECT * FROM games WHERE id = $1', [game.id])).rows[0];
    assert.equal((await request('/api/games', { session: player })).data.games.some((item) => item.id === game.id), false);
    assert.equal((await request(game.coverUrl, { session: player })).status, 404);
    assert.equal((await request(game.coverUrl, { session: master })).status, 200);
    for (const body of [form({ console: 'GB' }), form({ console: 'GBA' }), form({}, { rom: { name: 'replacement.gba', bytes: syntheticGbaRom() } })]) {
      assert.equal((await request(`/api/games/${game.id}`, { method: 'PATCH', session: master, body })).status, 400);
    }
    assert.equal((await request(`/api/games/${game.id}`, { method: 'PATCH', session: player, body: form({ active: true }) })).status, 403);
    const updated = await request(`/api/games/${game.id}`, { method: 'PATCH', session: master, body: form({ name: 'GBA público', active: true }) });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.game.id, game.id);
    assert.equal(updated.data.game.console, 'GBA');
    assert.equal((await request('/api/games', { session: player })).data.games.find((item) => item.id === game.id).console, 'GBA');
    assert.equal((await request(game.coverUrl, { session: player })).status, 200);
    await assert.rejects(pool.query("UPDATE games SET console='GB' WHERE id=$1", [game.id]), (error) => error.code === 'P0001');
    const final = (await pool.query('SELECT * FROM games WHERE id = $1', [game.id])).rows[0];
    for (const field of ['id', 'console', 'rom_key', 'rom_sha256', 'rom_size', 'cartridge_type', 'cgb_flag', 'created_at']) {
      assert.deepEqual(final[field], original[field]);
    }
    assert.deepEqual(await readFile(join(storageDirectory, 'roms', final.rom_key)), rom);
    for (const route of ['rom', 'download']) assert.equal((await request(`/api/games/${game.id}/${route}`, { session: master })).status, 404);
    assert.equal((await request(`/api/games/${game.id}`, { method: 'DELETE', session: master, body: {} })).status, 404);
  });

  test('aceita DMG compatível com CGB e ROM de 8 MiB dentro do limite', async () => {
    const dual = await createGame({ rom: syntheticRom({ cgbFlag: 0x80 }), name: 'Compatível DMG' });
    const maximum = await createGame({ rom: syntheticRom({ size: 8 * 1024 * 1024 }), name: 'Limite máximo sintético' });
    assert.equal((await pool.query('SELECT cgb_flag FROM games WHERE id = $1', [dual.game.id])).rows[0].cgb_flag, 0x80);
    assert.equal((await pool.query('SELECT rom_size FROM games WHERE id = $1', [maximum.game.id])).rows[0].rom_size, 8 * 1024 * 1024);
  });

  test('duplicata concorrente por SHA256 cria exatamente um registro e um arquivo', async () => {
    const rom = syntheticRom();
    const beforeFiles = await filesOnDisk();
    const responses = await Promise.all([1, 2].map((number) => request('/api/games', {
      method: 'POST', session: master, body: upload(rom, { name: `Duplicado ${number}` }),
    })));
    assert.deepEqual(responses.map((result) => result.status).sort(), [201, 409]);
    const found = await pool.query('SELECT id FROM games WHERE rom_sha256 = $1', [createHash('sha256').update(rom).digest('hex')]);
    assert.equal(found.rowCount, 1);
    assert.equal((await filesOnDisk()).length, beforeFiles.length + 1);
    assert.equal((await request('/api/games', { method: 'POST', session: master, body: upload(rom) })).status, 409);
  });

  test('capa JPEG é reprocessada como PNG e exige acesso ao jogo', async () => {
    const cover = await syntheticCover({ format: 'jpeg' });
    const result = await request('/api/games', {
      method: 'POST', session: master,
      body: form({ name: 'Capa sintética JPEG', active: true }, {
        rom: { bytes: syntheticRom(), name: 'synthetic.gb' },
        cover: { bytes: cover, name: 'synthetic.jpg', type: 'image/jpeg' },
      }),
    });
    assert.equal(result.status, 201);
    const game = result.data.game;
    assertPublicGame(game);
    assert.equal(game.hasCover, true);
    assert.equal((await request(game.coverUrl)).status, 401);
    assert.equal((await request(game.coverUrl, { session: temporary })).status, 403);
    const served = await request(game.coverUrl, { session: player });
    assert.equal(served.status, 200);
    assert.match(served.headers.get('content-type'), /^image\/png/);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    const metadata = await sharp(served.bytes).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 64);
    assert.equal(metadata.height, 96);
    assert.equal(metadata.exif, undefined);
  });

  test('edição preserva ID e ROM; desativação, reativação e remoção da capa são reversíveis', async () => {
    const { game, rom } = await createGame({ cover: await syntheticCover(), name: 'Antes da edição' });
    const original = (await pool.query('SELECT * FROM games WHERE id = $1', [game.id])).rows[0];
    const edit = await request(`/api/games/${game.id}`, {
      method: 'PATCH', session: master, body: form({ name: 'Depois da edição', active: false }),
    });
    assert.equal(edit.status, 200);
    assert.equal(edit.data.game.id, game.id);
    assert.equal(edit.data.game.name, 'Depois da edição');
    assert.equal(edit.data.game.active, false);
    const playerList = await request('/api/games', { session: player });
    assert.equal(playerList.data.games.some((item) => item.id === game.id), false);
    assert.ok((await request('/api/games', { session: master })).data.games.some((item) => item.id === game.id));
    assert.equal((await request(game.coverUrl, { session: player })).status, 404);
    assert.equal((await request(game.coverUrl, { session: master })).status, 200);
    const restored = await request(`/api/games/${game.id}`, {
      method: 'PATCH', session: master, body: form({ name: 'Antes da edição', active: true }),
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.game.id, game.id);
    assert.equal((await request(game.coverUrl, { session: player })).status, 200);
    const replaced = await request(`/api/games/${game.id}`, {
      method: 'PATCH', session: master,
      body: form({}, { cover: { bytes: await syntheticCover({ background: '#b48241' }), name: 'replacement.png', type: 'image/png' } }),
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.data.game.id, game.id);
    const removed = await request(`/api/games/${game.id}`, {
      method: 'PATCH', session: master, body: form({ removeCover: 'true' }),
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.game.hasCover, false);
    assert.equal(removed.data.game.coverUrl, null);
    assert.equal((await request(game.coverUrl, { session: master })).status, 404);
    const final = (await pool.query('SELECT * FROM games WHERE id = $1', [game.id])).rows[0];
    assert.equal(final.rom_key, original.rom_key);
    assert.equal(final.rom_sha256, original.rom_sha256);
    assert.deepEqual(await readFile(join(storageDirectory, 'roms', final.rom_key)), rom);
  });

  test('não oferece substituição de ROM, exclusão ou rota para baixar o cartucho', async () => {
    const { game } = await createGame();
    assert.equal((await request(`/api/games/${game.id}`, {
      method: 'PATCH', session: master, body: form({}, { rom: { bytes: syntheticRom(), name: 'replacement.gb' } }),
    })).status, 400);
    assert.equal((await request(`/api/games/${game.id}`, {
      method: 'PATCH', session: master, body: form({ removeCover: true }, {
        cover: { bytes: await syntheticCover(), name: 'conflict.png', type: 'image/png' },
      }),
    })).status, 400);
    for (const session of [master, player]) {
      assert.equal((await request(`/api/games/${game.id}/rom`, { session })).status, 404);
      assert.equal((await request(`/api/games/${game.id}/download`, { session })).status, 404);
    }
    assert.equal((await request(`/api/games/${game.id}`, { method: 'DELETE', session: master, body: {} })).status, 404);
    assert.equal((await pool.query('SELECT id FROM games WHERE id = $1', [game.id])).rowCount, 1);
    await assert.rejects(pool.query('UPDATE games SET rom_sha256 = $1 WHERE id = $2', [randomBytes(32).toString('hex'), game.id]),
      (error) => error.code === 'P0001');
  });

  test('capa com integridade inválida não é servida; restauração do arquivo recupera o acesso', async () => {
    const { game } = await createGame({ cover: await syntheticCover() });
    const record = (await pool.query('SELECT cover_key FROM games WHERE id = $1', [game.id])).rows[0];
    const path = join(storageDirectory, 'covers', record.cover_key);
    const original = await readFile(path);
    const corrupted = Buffer.from(original);
    corrupted[0] ^= 1;
    try {
      await writeFile(path, corrupted);
      const response = await request(game.coverUrl, { session: player });
      assert.equal(response.status, 503);
      assert.match(response.headers.get('content-type'), /application\/json/);
    } finally { await writeFile(path, original); }
    assert.equal((await request(game.coverUrl, { session: player })).status, 200);
  });

  test('dois uploads em andamento limitam o terceiro e abortar os sockets libera a admissão', async () => {
    const interceptor = app.get(CatalogUploadInterceptor);
    const held = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        const boundary = `catalog-test-${randomBytes(8).toString('hex')}`;
        const stream = httpRequest(`${baseUrl}/api/games`, {
          method: 'POST',
          headers: {
            Origin: origin, Cookie: master.cookie,
            'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': master.csrfToken,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Transfer-Encoding': 'chunked',
          },
        });
        stream.on('error', () => { /* Deliberate abort after asserting admission. */ });
        stream.on('response', (response) => response.resume());
        held.push(stream);
        stream.write(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nEnvio aberto\r\n`);
      }
      // Synchronize the stream fixture with parser admission instead of sleeping
      // an arbitrary amount of time or waiting for the production timeout.
      await waitUntil(() => interceptor.active === 2, 'Os dois parsers devem aguardar o fim dos uploads.');
      assert.equal((await request('/api/games', { method: 'POST', session: master, body: upload() })).status, 429);
    } finally { held.forEach((stream) => stream.destroy()); }
    await waitUntil(() => interceptor.active === 0, 'Abortar uploads deve liberar ambas as vagas.');
    await createGame({ name: 'Após abortar uploads' });
  });

  test('falha de armazenamento não cria metadados nem deixa a ROM escrita antes da capa', async () => {
    const storage = app.get(CatalogStorageService);
    const originalWrite = storage.write;
    const beforeFiles = await filesOnDisk();
    const beforeCount = (await pool.query('SELECT count(*) FROM games')).rows[0].count;
    let writes = 0;
    storage.write = async function (...args) {
      writes += 1;
      if (writes === 2) throw new Error('Falha de gravação controlada no teste isolado.');
      return originalWrite.apply(this, args);
    };
    try {
      const failed = await request('/api/games', { method: 'POST', session: master, body: upload(syntheticRom(), { cover: await syntheticCover() }) });
      assert.equal(failed.status, 500);
      assert.equal(writes, 2);
    } finally { storage.write = originalWrite; }
    assert.equal((await pool.query('SELECT count(*) FROM games')).rows[0].count, beforeCount);
    assert.deepEqual(await filesOnDisk(), beforeFiles);
  });

  test('rollback do banco limpa arquivos novos e preserva o catálogo anterior', async () => {
    const beforeFiles = await filesOnDisk();
    const beforeCount = (await pool.query('SELECT count(*) FROM games')).rows[0].count;
    await pool.query(`CREATE FUNCTION catalog_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falha transacional controlada'; END $$;
      CREATE TRIGGER catalog_test_reject BEFORE INSERT ON games FOR EACH ROW EXECUTE FUNCTION catalog_test_reject();`);
    try {
      assert.equal((await request('/api/games', {
        method: 'POST', session: master, body: upload(syntheticRom(), { cover: await syntheticCover() }),
      })).status, 500);
    } finally {
      await pool.query('DROP TRIGGER catalog_test_reject ON games; DROP FUNCTION catalog_test_reject();');
    }
    assert.equal((await pool.query('SELECT count(*) FROM games')).rows[0].count, beforeCount);
    assert.deepEqual(await filesOnDisk(), beforeFiles);
  });

  test('GB e GBA preservam console, metadados, arquivos e capas após reiniciar a aplicação', async () => {
    const entries = [];
    for (const [console, rom, filename] of [['GB', syntheticRom(), 'persist.gb'], ['GBA', syntheticGbaRom(), 'persist.gba']]) {
      const { game } = await createGame({ rom, filename, name: `Persistência sintética ${console}`, cover: await syntheticCover() });
      const record = (await pool.query('SELECT * FROM games WHERE id = $1', [game.id])).rows[0];
      const beforeCover = await request(game.coverUrl, { session: player });
      entries.push({ game, rom, record, beforeCover });
    }
    await app.close();
    app = undefined;
    await startApp();
    const after = await request('/api/games', { session: player });
    assert.equal(after.status, 200);
    for (const { game, rom, record, beforeCover } of entries) {
      assert.deepEqual(after.data.games.find((item) => item.id === game.id), game);
      const cover = await request(game.coverUrl, { session: player });
      assert.equal(cover.status, 200);
      assert.deepEqual(cover.bytes, beforeCover.bytes);
      assert.deepEqual(await readFile(join(storageDirectory, 'roms', record.rom_key)), rom);
    }
  });
});
