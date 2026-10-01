import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import argon2 from 'argon2';
import pg from 'pg';
import { databaseConfig } from '../backend/dist/config.js';
import { syntheticGbaRom, syntheticRom } from './helpers/catalog-fixtures.mjs';

const database = `emulador_test_${randomBytes(10).toString('hex')}`;
const originalEnvironment = Object.fromEntries(['PGDATABASE', 'APP_ORIGIN', 'CATALOG_STORAGE_DIR'].map(key => [key, process.env[key]]));
const admin = new pg.Pool(databaseConfig());
const origin = 'http://127.0.0.1:5173';
const password = randomBytes(24).toString('base64url');
let ownsDatabase = false, pool, storage, app, baseUrl, hash, createApp, master, player, other, temporary;

const checksum = data => createHash('sha256').update(data).digest('hex');
async function request(path, { method = 'GET', body, session, headers: overrides = {}, signal } = {}) {
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
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: payload, signal });
  const bytes = Buffer.from(await response.arrayBuffer());
  const data = bytes.length && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : undefined;
  return { status: response.status, headers: response.headers, data, bytes };
}
async function user(role = 'JOGADOR', mustChange = false) {
  const id = randomUUID(), username = `play_${randomBytes(6).toString('hex')}`;
  await pool.query('INSERT INTO users(id,username,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,$5)', [id,username,hash,role,mustChange]);
  const result = await request('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(result.status, 200);
  return { id, username, cookie: result.headers.get('set-cookie').split(';')[0], csrfToken: result.data.csrfToken };
}
async function game(console = 'GB', active = true) {
  const bytes = console === 'GBA' ? syntheticGbaRom() : syntheticRom();
  const form = new FormData();
  form.append('name', `Fixture ${console}`); form.append('active', String(active));
  form.append('rom', new Blob([bytes]), console === 'GBA' ? 'fixture.gba' : 'fixture.gb');
  const result = await request('/api/games', { method: 'POST', session: master, body: form });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return { ...result.data.game, bytes };
}
const playPath = (game, suffix = '') => `/api/play/${game.id}${suffix}`;
async function acquire(game, session = player) {
  const response = await request(playPath(game, '/lease'), { method: 'POST', session, body: {} });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}
const saveBody = (lease, bytes, version = 0) => ({ leaseId: lease.leaseId, baseVersion: version, dataBase64: bytes.toString('base64'), sha256: checksum(bytes) });
async function save(game, lease, bytes, version = 0, session = player) {
  return request(playPath(game, '/save'), { method: 'PUT', session, body: saveBody(lease,bytes,version) });
}
async function stored(game, session = player) {
  return (await pool.query('SELECT * FROM game_saves WHERE user_id=$1 AND game_id=$2', [session.id,game.id])).rows[0];
}
async function start() { app = await createApp(); await app.listen(0, '127.0.0.1'); baseUrl = await app.getUrl(); }
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(10); }
  assert.fail('O estado assíncrono esperado não foi alcançado.');
}

describe('Player privado e save nativo com banco isolado', { concurrency: false }, () => {
  before(async () => {
    await admin.query(`CREATE DATABASE "${database}"`); ownsDatabase = true;
    storage = await mkdtemp(join(tmpdir(), 'emulador-play-api-'));
    process.env.PGDATABASE = database; process.env.APP_ORIGIN = origin; process.env.CATALOG_STORAGE_DIR = storage;
    pool = new pg.Pool(databaseConfig());
    const { migrate } = await import('../backend/dist/database/migrations.js');
    await migrate(pool); await migrate(pool);
    hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    ({ createApp } = await import('../backend/dist/app.js'));
    await start();
    master = await user('MASTER'); player = await user(); other = await user(); temporary = await user('JOGADOR',true);
  });
  after(async () => {
    try {
      if (app) await app.close();
      if (pool) await pool.end();
      if (ownsDatabase) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    } finally {
      await admin.end();
      if (storage) await rm(storage, { recursive: true, force: true });
      for (const [key,value] of Object.entries(originalEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  test('manifesto e ROM exigem sessão e senha definitiva; console escolhe adapter fixo', async () => {
    for (const console of ['GB','GBA']) {
      const g = await game(console);
      for (const suffix of ['', '/rom']) {
        assert.equal((await request(playPath(g,suffix))).status,401);
        assert.equal((await request(playPath(g,suffix),{session:temporary})).status,403);
      }
      for (const session of [master,player]) {
        const manifest = await request(playPath(g),{session});
        assert.deepEqual(manifest.data.game,{id:g.id,name:g.name,console});
        assert.equal(manifest.data.core,console === 'GB' ? 'mgba-gb-v1' : 'mgba-gba-v1');
        assert.equal(manifest.data.romUrl,playPath(g,'/rom'));
        const rom = await request(manifest.data.romUrl,{session});
        assert.equal(rom.status,200); assert.deepEqual(rom.bytes,g.bytes);
        assert.equal(rom.headers.get('cache-control'),'no-store');
        assert.equal(rom.headers.get('content-type'),'application/octet-stream');
        assert.equal(rom.headers.get('content-disposition'),'inline');
      }
    }
  });

  test('jogo inativo bloqueia manifesto, ROM, lease e save inclusive para master', async () => {
    const g = await game('GBA',false);
    for (const session of [master,player]) {
      for (const suffix of ['', '/rom']) assert.equal((await request(playPath(g,suffix),{session})).status,404);
      for (const [method,suffix,body] of [['POST','/lease',{}],['POST','/lease/renew',{leaseId:randomUUID()}],['DELETE','/lease',{leaseId:randomUUID()}],['PUT','/save',saveBody({leaseId:randomUUID()},Buffer.from('a'))]]) {
        assert.equal((await request(playPath(g,suffix),{method,session,body})).status,404);
      }
    }
  });

  test('guards recusam JSON grande antes do parser; origem/AJAX/CSRF obrigatórios', async () => {
    const g = await game();
    const largeInvalid = 'x'.repeat(1700000);
    for (const [session,status] of [[undefined,401],[temporary,403]]) {
      const result = await request(playPath(g,'/save'),{method:'PUT',session,body:largeInvalid,headers:{'Content-Type':'application/json'}});
      assert.equal(result.status,status);
    }
    for (const headers of [{Origin:null},{Origin:'https://invalid.example'},{'X-Requested-With':null},{'X-CSRF-Token':null},{'X-CSRF-Token':other.csrfToken}]) {
      assert.equal((await request(playPath(g,'/lease'),{method:'POST',session:player,body:{},headers})).status,403);
    }
    assert.equal((await request(playPath(g,'/save'),{method:'PUT',session:player,body:largeInvalid,headers:{'Content-Type':'application/json'}})).status,413);
    assert.equal((await request('/api/auth/password',{method:'POST',session:player,body:{currentPassword:password,newPassword:'x'.repeat(17000)}})).status,413);
  });

  test('lease exclusiva por usuário/jogo é persistida por hash e aquisição concorrente tem um vencedor', async () => {
    const g = await game();
    const attempts = await Promise.all([1,2].map(() => request(playPath(g,'/lease'),{method:'POST',session:player,body:{}})));
    assert.deepEqual(attempts.map(r=>r.status).sort(),[201,409]);
    const lease = attempts.find(r=>r.status===201).data;
    assert.deepEqual(lease.save,{epoch:null,dataBase64:null,sha256:null,version:0,updatedAt:null});
    const persisted = (await pool.query('SELECT * FROM play_leases WHERE user_id=$1 AND game_id=$2',[player.id,g.id])).rows[0];
    assert.equal(persisted.token_hash,checksum(Buffer.from(lease.leaseId)));
    assert.ok(!JSON.stringify(persisted).includes(lease.leaseId));
    assert.equal((await request(playPath(g,'/lease/renew'),{method:'POST',session:player,body:{leaseId:lease.leaseId}})).status,200);
    await acquire(g,other); // Same game, separate user, separate lease/save.
    assert.equal((await save(g,lease,Buffer.from(' чужой '),0,other)).status,409);
    for (let n=0;n<2;n++) assert.equal((await request(playPath(g,'/lease'),{method:'DELETE',session:player,body:{leaseId:lease.leaseId}})).status,204);
    await acquire(g);
  });

  test('save nativo usa CAS atômico, checksum, idempotência e limite de uma alteração/segundo', async () => {
    const g = await game(), lease = await acquire(g), bytes = randomBytes(8192);
    const first = await save(g,lease,bytes);
    assert.equal(first.status,200); assert.equal(first.data.save.version,1);
    const retry = await save(g,lease,bytes);
    assert.equal(retry.status,200); assert.deepEqual(retry.data,first.data);
    assert.equal((await save(g,lease,bytes,1)).status,200);
    assert.equal((await save(g,lease,Buffer.from('changed'),0)).status,409);
    const fast = await save(g,lease,Buffer.from('changed'),1);
    assert.equal(fast.status,429); assert.equal(fast.headers.get('retry-after'),'1');
    assert.deepEqual((await stored(g)).data,bytes);
    await pool.query("UPDATE game_saves SET updated_at=clock_timestamp()-interval '2 seconds' WHERE user_id=$1 AND game_id=$2",[player.id,g.id]);
    assert.equal((await save(g,lease,Buffer.from('changed'),1)).data.save.version,2);
    assert.equal((await save(g,lease,Buffer.from('changed'),0)).status,409);
    assert.equal(Number((await pool.query('SELECT count(*) FROM game_saves WHERE user_id=$1 AND game_id=$2',[player.id,g.id])).rows[0].count),1);
  });

  test('dois escritores concorrentes não sobrescrevem a versão vencedora', async () => {
    const g = await game(), lease = await acquire(g);
    const attempts = await Promise.all([Buffer.from('first'),Buffer.from('second')].map(bytes=>save(g,lease,bytes)));
    assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
    assert.equal((await stored(g)).version,1);
    assert.equal((await stored(g)).sha256,attempts.find(r=>r.status===200).data.save.sha256);
  });

  test('save/lease não aceitam usuário, core, arquivo, base64 malformado ou checksum divergente', async () => {
    const g = await game(), lease = await acquire(g), bytes = Buffer.from('native');
    const original = saveBody(lease,bytes);
    for (const change of [{userId:other.id},{core:'other'},{dataBase64:''},{dataBase64:'!!!!'},{dataBase64:'Zg=='},{dataBase64:'Zg='},{baseVersion:-1},{baseVersion:1.5},{leaseId:'invalid'},{sha256:'a'.repeat(64)}]) {
      assert.equal((await request(playPath(g,'/save'),{method:'PUT',session:player,body:{...original,...change}})).status,400);
    }
    assert.equal(await stored(g),undefined);
    assert.equal((await request(playPath(g,'/lease'),{method:'POST',session:other,body:{userId:player.id}})).status,400);
    assert.equal((await request(playPath(g,'/save'),{method:'POST',session:player,body:original})).status,404);
    assert.equal((await request(playPath(g,'/save'),{session:player})).status,404);
  });

  test('aceita 1 MiB exato e rejeita acima do limite preservando o save', async () => {
    const g = await game('GBA'), lease = await acquire(g), bytes = randomBytes(1024*1024);
    assert.equal((await save(g,lease,bytes)).status,200);
    assert.equal((await stored(g)).size,bytes.length);
    assert.equal((await save(g,lease,Buffer.alloc(1024*1024+1),1)).status,413);
    assert.equal((await stored(g)).sha256,checksum(bytes));
    await assert.rejects(pool.query('UPDATE game_saves SET sha256=$1 WHERE user_id=$2 AND game_id=$3',['0'.repeat(64),player.id,g.id]),error=>error.code==='23514');
    await assert.rejects(pool.query('UPDATE game_saves SET size=1 WHERE user_id=$1 AND game_id=$2',[player.id,g.id]),error=>error.code==='23514');
  });

  test('isola saves por usuário e jogo; adquirir lease retorna somente o próprio progresso', async () => {
    const a = await game(), b = await game('GBA');
    const leaseA = await acquire(a), leaseB = await acquire(b), leaseOther = await acquire(a,other);
    const bytesA = Buffer.from('player-game-a'), bytesB = Buffer.from('player-game-b'), bytesOther = Buffer.from('other-game-a');
    assert.equal((await save(a,leaseA,bytesA)).status,200);
    assert.equal((await save(b,leaseB,bytesB)).status,200);
    assert.equal((await save(a,leaseOther,bytesOther,0,other)).status,200);
    for (const [g,lease,session,bytes] of [[a,leaseA,player,bytesA],[b,leaseB,player,bytesB],[a,leaseOther,other,bytesOther]]) {
      await request(playPath(g,'/lease'),{method:'DELETE',session,body:{leaseId:lease.leaseId}});
      const reopened = await acquire(g,session);
      assert.equal(reopened.save.version,1);
      assert.deepEqual(Buffer.from(reopened.save.dataBase64,'base64'),bytes);
    }
  });

  test('lease expirada não escreve e a nova aquisição carrega o último save confirmado', async () => {
    const g = await game(), lease = await acquire(g), bytes = Buffer.from('preserved');
    assert.equal((await save(g,lease,bytes)).status,200);
    await pool.query("UPDATE play_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND game_id=$2",[player.id,g.id]);
    assert.equal((await save(g,lease,Buffer.from('stale'),1)).status,409);
    assert.equal((await request(playPath(g,'/lease/renew'),{method:'POST',session:player,body:{leaseId:lease.leaseId}})).status,409);
    const next = await acquire(g);
    assert.notEqual(next.leaseId,lease.leaseId); assert.equal(next.save.sha256,checksum(bytes));
    assert.equal((await save(g,lease,Buffer.from('old-tab'),1)).status,409);
    await request(playPath(g,'/lease'),{method:'DELETE',session:player,body:{leaseId:lease.leaseId}});
    assert.equal((await request(playPath(g,'/lease/renew'),{method:'POST',session:player,body:{leaseId:next.leaseId}})).status,200);
  });

  test('desativação e revogação bloqueiam sessão de jogo sem apagar saves', async () => {
    for (const action of ['logout','block','reset']) {
      const account = await user(), g = await game(), lease = await acquire(g,account), bytes = Buffer.from(`preserved-${action}`);
      assert.equal((await save(g,lease,bytes,0,account)).status,200);
      if (action==='logout') assert.equal((await request('/api/auth/logout',{method:'POST',session:account,body:{}})).status,204);
      if (action==='block') assert.equal((await request(`/api/users/${account.id}/status`,{method:'PATCH',session:master,body:{blocked:true}})).status,200);
      if (action==='reset') assert.equal((await request(`/api/users/${account.id}/reset-password`,{method:'POST',session:master,body:{password:randomBytes(24).toString('base64url')}})).status,204);
      assert.equal((await save(g,lease,Buffer.from('invalid'),1,account)).status,401);
      assert.equal((await request(playPath(g,'/rom'),{session:account})).status,401);
      assert.equal(Number((await pool.query('SELECT count(*) FROM play_leases WHERE user_id=$1',[account.id])).rows[0].count),0);
      assert.deepEqual((await stored(g,account)).data,bytes);
    }
    const g = await game(), lease = await acquire(g);
    assert.equal((await save(g,lease,Buffer.from('before-disable'))).status,200);
    const form = new FormData(); form.append('active','false');
    assert.equal((await request(`/api/games/${g.id}`,{method:'PATCH',session:master,body:form})).status,200);
    assert.equal((await save(g,lease,Buffer.from('after-disable'),1)).status,404);
    assert.equal((await request(playPath(g,'/lease/renew'),{method:'POST',session:player,body:{leaseId:lease.leaseId}})).status,404);
    assert.equal((await stored(g)).version,1);
  });

  test('falha de integridade e symlink na ROM retornam503 sem vazar arquivos', async () => {
    const g = await game();
    const row = (await pool.query('SELECT rom_key FROM games WHERE id=$1',[g.id])).rows[0];
    const path = join(storage,'roms',row.rom_key), bytes = await readFile(path);
    const corrupted = Buffer.from(bytes); corrupted[0x160] ^= 1;
    await writeFile(path,corrupted);
    assert.equal((await request(playPath(g,'/rom'),{session:player})).status,503);
    await rename(path,`${path}.test-original`);
    try {
      await symlink(`${path}.test-original`,path);
      assert.equal((await request(playPath(g,'/rom'),{session:player})).status,503);
    } finally { await unlink(path); await rename(`${path}.test-original`,path); await writeFile(path,bytes); }
    assert.equal((await request(playPath(g,'/rom'),{session:player})).status,200);
  });

  test('gate limita ROMs e mantém a vaga de leitura após abort até concluir o trabalho', async () => {
    const g = await game();
    const { CatalogStorageService } = await import('../backend/dist/games/catalog-storage.service.js');
    const { RomResponseInterceptor } = await import('../backend/dist/play/rom-response.interceptor.js');
    const storageService = app.get(CatalogStorageService), gate = app.get(RomResponseInterceptor);
    const original = storageService.readRom.bind(storageService);
    let release;
    const held = new Promise(resolve=>{release=resolve;});
    storageService.readRom = async (...args) => { await held; return original(...args); };
    const abort = new AbortController();
    let first,second;
    try {
      first = request(playPath(g,'/rom'),{session:player,signal:abort.signal}).catch(()=>undefined);
      second = request(playPath(g,'/rom'),{session:other});
      await waitFor(()=>gate.active===2);
      abort.abort(); await first;
      assert.equal((await request(playPath(g,'/rom'),{session:master})).status,429);
      release(); assert.equal((await second).status,200);
      await waitFor(()=>gate.active===0);
      assert.equal((await request(playPath(g,'/rom'),{session:master})).status,200);
    } finally { release(); await Promise.allSettled([first,second]); storageService.readRom=original; }
  });

  test('save respeita a trava comum de backup e continua após sua liberação', async () => {
    const g = await game(), lease = await acquire(g), client = await pool.connect();
    let pending;
    try {
      await client.query('SELECT pg_advisory_lock(781004)');
      pending = save(g,lease,Buffer.from('backup-serialized'));
      await waitFor(async()=>Number((await pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND wait_event='advisory'",[database])).rows[0].count)>0);
      assert.equal(await stored(g),undefined);
      await client.query('SELECT pg_advisory_unlock(781004)');
      assert.equal((await pending).status,200);
    } finally { await client.query('SELECT pg_advisory_unlock_all()'); client.release(); if (pending) await pending; }
  });

  test('quota de 10.000 saves recusa nova entrada sem afetar progresso existente', async () => {
    const g = await game(), lease = await acquire(g), bytes = Buffer.from('quota-preserved');
    assert.equal((await save(g,lease,bytes)).status,200);
    const otherGame = await game(), otherLease = await acquire(otherGame);
    const existingCount = Number((await pool.query('SELECT count(*) FROM game_saves')).rows[0].count);
    const prefix = `quota_${randomBytes(5).toString('hex')}_`;
    try {
      await pool.query(`WITH accounts AS (
        INSERT INTO users(id,username,password_hash,role)
        SELECT gen_random_uuid(),$1||n::text,$2,'JOGADOR' FROM generate_series(1,$3::integer) n
        RETURNING id
      ) INSERT INTO game_saves(user_id,game_id,data,sha256,size,version)
        SELECT id,$4,decode('61','hex'),encode(sha256(decode('61','hex')),'hex'),1,1 FROM accounts`,[prefix,hash,10000-existingCount,g.id]);
      assert.equal((await save(otherGame,otherLease,Buffer.from('excess'))).status,507);
      assert.equal(await stored(otherGame),undefined);
      assert.deepEqual((await stored(g)).data,bytes);
      assert.equal((await save(g,lease,bytes)).status,200); // An idempotent retry needs no quota.
    } finally { await pool.query('DELETE FROM users WHERE username LIKE $1',[`${prefix}%`]); }
  });

  test('save e lease persistem após reinício da aplicação sem criar progresso vazio', async () => {
    const g = await game('GBA'), lease = await acquire(g), bytes = randomBytes(32768);
    assert.equal((await save(g,lease,bytes)).status,200);
    await app.close(); app=undefined; await start();
    assert.equal((await request(playPath(g,'/lease'),{method:'POST',session:player,body:{}})).status,409);
    assert.equal((await save(g,lease,bytes)).status,200);
    await request(playPath(g,'/lease'),{method:'DELETE',session:player,body:{leaseId:lease.leaseId}});
    const next = await acquire(g);
    assert.deepEqual(Buffer.from(next.save.dataBase64,'base64'),bytes); assert.equal(next.save.version,1);
    const empty = await game(); await acquire(empty);
    assert.equal(await stored(empty),undefined);
  });
  test('takeover CAS tem um vencedor, isola usuário/jogo e invalida dono antigo', async () => {
    const g = await game(), lease = await acquire(g), bytes = Buffer.from('confirmed-before-takeover');
    assert.equal((await save(g, lease, bytes)).status, 200);
    const observed = await request(playPath(g, '/lease'), { session: player });
    assert.equal(observed.status, 200);
    const generation = observed.data.reservation.generation;
    assert.match(generation, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(observed.data).includes(lease.leaseId));
    assert.equal((await request(playPath(g, '/lease'), { session: other })).data.reservation, null);
    const take = (session = player, target = g) => request(playPath(target, '/lease'), { method: 'POST', session, body: { expectedGeneration: generation } });
    assert.equal((await take(other)).status, 409);
    const otherGame = await game(); assert.equal((await take(player, otherGame)).status, 409);
    assert.equal((await request(playPath(g, '/lease'), { method: 'POST', session: player, body: { expectedGeneration: generation }, headers: { 'X-CSRF-Token': null } })).status, 403);
    const attempts = await Promise.all([take(), take()]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [201, 409]);
    const winner = attempts.find(r => r.status === 201).data;
    assert.notEqual(winner.leaseId, lease.leaseId);
    assert.equal(winner.save.dataBase64, bytes.toString('base64'));
    assert.equal((await take()).status, 409);
    assert.equal((await save(g, lease, Buffer.from('obsolete'), 1)).status, 409);
    assert.equal((await request(playPath(g, '/lease/renew'), { method: 'POST', session: player, body: { leaseId: lease.leaseId } })).status, 409);
    assert.equal((await request(playPath(g, '/lease'), { method: 'DELETE', session: player, body: { leaseId: lease.leaseId } })).status, 204);
    assert.equal((await request(playPath(g, '/lease/renew'), { method: 'POST', session: player, body: { leaseId: winner.leaseId } })).status, 200);
    assert.deepEqual((await stored(g)).data, bytes);
    await pool.query("UPDATE game_saves SET updated_at=clock_timestamp()-interval '2 seconds' WHERE user_id=$1 AND game_id=$2", [player.id,g.id]);
    assert.equal((await save(g, winner, Buffer.from('new-owner'), 1)).status, 200);
    await pool.query('UPDATE games SET active=false WHERE id=$1', [g.id]);
    assert.equal((await take()).status, 404);
  });

  test('takeover protege contra save, renovação e liberação antigos já em voo', async () => {
    const g = await game(), lease = await acquire(g), bytes = Buffer.from('safe');
    assert.equal((await save(g, lease, bytes)).status, 200);
    const generation = (await request(playPath(g, '/lease'), { session: player })).data.reservation.generation;
    const client = await pool.connect();
    const pending = [];
    const blocked = async count => waitFor(async () => Number((await pool.query(
      "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM users WHERE id =%'"
    )).rows[0].count) >= count);
    try {
      await client.query('BEGIN'); await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [player.id]);
      pending.push(request(playPath(g, '/lease'), { method:'POST', session:player, body:{expectedGeneration:generation} }));
      await blocked(1);
      pending.push(save(g, lease, Buffer.from('late'), 1));
      pending.push(request(playPath(g, '/lease/renew'), {method:'POST',session:player,body:{leaseId:lease.leaseId}}));
      pending.push(request(playPath(g, '/lease'), {method:'DELETE',session:player,body:{leaseId:lease.leaseId}}));
      await blocked(4); await client.query('COMMIT');
      const [next, oldSave, oldRenew, oldRelease] = await Promise.all(pending);
      assert.deepEqual([next.status,oldSave.status,oldRenew.status,oldRelease.status],[201,409,409,204]);
      assert.equal((await request(playPath(g,'/lease/renew'),{method:'POST',session:player,body:{leaseId:next.data.leaseId}})).status,200);
      assert.deepEqual((await stored(g)).data,bytes);
    } finally { await client.query('ROLLBACK'); client.release(); await Promise.allSettled(pending); }
  });

  test('states: slots/versionamento, permissões, lease, corrupção, reset nativo e reinício',async()=>{
   const {STATE_CORE}=await import('../backend/dist/play/states.service.js');
   const g=await game(),lease=await acquire(g),native=Buffer.from('native-before');await save(g,lease,native);
   const meta=(await request(playPath(g,'/states'),{session:player})).data;
   const data=Buffer.alloc(71680,7);
   const payload={leaseId:lease.leaseId,version:0,label:'Ponto',coreId:STATE_CORE,romHash:meta.romHash,format:1,dataBase64:data.toString('base64'),nativeBase64:native.toString('base64'),sha256:checksum(data),nativeSha256:checksum(native)};
   const put=(body=payload,slot=0,session=player)=>request(playPath(g,`/states/${slot}`),{method:'PUT',session,body});
   assert.equal((await put({...payload,sha256:'0'.repeat(64)})).status,400);
   assert.equal((await put({...payload,coreId:'wrong'})).status,400);
   assert.equal((await put({...payload,dataBase64:Buffer.alloc(71679).toString('base64'),sha256:checksum(Buffer.alloc(71679))})).status,400);
   assert.equal((await put(payload,4)).status,413); // route-scoped parser does not accept extra slots
   assert.equal((await put(payload,0,other)).status,409);
   assert.equal((await request(playPath(g,'/states/0'),{method:'PUT',session:player,headers:{'X-CSRF-Token':null},body:payload})).status,403);
   const oversized=Buffer.alloc(524289);assert.equal((await put({...payload,dataBase64:oversized.toString('base64'),sha256:checksum(oversized)})).status,400);
   const results=await Promise.all([put(),put({...payload,label:'Concurrent'})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
   const first=(await request(playPath(g,'/states'),{session:player})).data.slots[0];
   const winner={...payload,label:first.label};assert.equal((await put(winner)).status,200);
   assert.equal((await request('/api/saves?admin=true',{session:player})).status,403);
   assert.equal((await request('/api/saves',{session:other})).data.saves.length,0);
   assert.ok((await request('/api/saves?admin=true',{session:master})).data.saves.some(r=>r.user_id===player.id&&r.game_id===g.id));
   const foreign=await acquire(g,master);
   assert.equal((await request(playPath(g,'/states/0/load'),{method:'POST',session:master,body:{leaseId:foreign.leaseId,version:1}})).status,404);
   const generation=(await request(playPath(g,'/lease'),{session:player})).data.reservation.generation;
   const next=(await request(playPath(g,'/lease'),{method:'POST',session:player,body:{expectedGeneration:generation}})).data;
   assert.equal((await put({...winner,version:1})).status,409);
   assert.equal((await request(playPath(g,'/states/0/load'),{method:'POST',session:player,body:{leaseId:lease.leaseId,version:1}})).status,409);
   const del=(kind,session=player,owner=player.id,v=1)=>request(`/api/saves/${owner}/${g.id}/${kind}`,{method:'DELETE',session,body:{version:v,confirmation:'EXCLUIR'}});
   assert.equal((await del('native')).status,409);
   assert.equal((await del('0',other)).status,403);
   const locked=await pool.connect();try{await locked.query('BEGIN');await locked.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[player.id]);assert.equal((await del('0',master)).status,409);}finally{await locked.query('ROLLBACK');locked.release();}
   await app.close();await start();
   const loaded=await request(playPath(g,'/states/0/load'),{method:'POST',session:player,body:{leaseId:next.leaseId,version:1}});assert.equal(loaded.status,201);assert.equal(loaded.data.state.dataBase64,payload.dataBase64);
   await request(playPath(g,'/lease'),{method:'DELETE',session:player,body:{leaseId:next.leaseId}});
   assert.equal((await del('native',master)).status,204); // Nest method default for DELETE controller is 204
   const reset=await acquire(g);assert.equal(reset.save.version,0);assert.ok(reset.save.epoch);
   assert.equal((await save(g,reset,native)).status,409);
   assert.equal((await request(playPath(g,'/save'),{method:'PUT',session:player,body:{...saveBody(reset,native),epoch:reset.save.epoch}})).status,200);
   assert.equal((await del('0',master)).status,204);
   assert.equal((await put({...payload,leaseId:reset.leaseId,version:1})).status,409);
   assert.equal((await put({...payload,leaseId:reset.leaseId,version:2})).status,200);
   await request(playPath(g,'/lease'),{method:'DELETE',session:player,body:{leaseId:reset.leaseId}});
   assert.equal((await del('native',master)).status,409); // stale confirmation cannot delete a new version 1
   assert.ok(await stored(g));
  });

  test('states: quotas de usuário/global em PostgreSQL isolado',async()=>{
   const {STATE_CORE}=await import('../backend/dist/play/states.service.js');
   const g=await game(),lease=await acquire(g),data=Buffer.alloc(71680,9),native=Buffer.alloc(1048576,8);
   const meta=(await request(playPath(g,'/states'),{session:player})).data;
   const payload={leaseId:lease.leaseId,version:0,label:'Quota',coreId:STATE_CORE,romHash:meta.romHash,format:1,dataBase64:data.toString('base64'),nativeBase64:native.toString('base64'),sha256:checksum(data),nativeSha256:checksum(native)};
   const ids=[];
   for(let i=0;i<239;i++){const id=randomUUID();ids.push(id);await pool.query("INSERT INTO games(id,name,active,rom_key,rom_sha256,rom_size,cartridge_type,cgb_flag,console) VALUES($1,'Quota fixture',true,$2,$3,32768,3,0,'GB')",[id,id+'.gb',checksum(Buffer.from(id))]);}
   async function fill(owner,gameIds){await pool.query(`INSERT INTO save_states(user_id,game_id,slot,version,label,console,rom_sha256,core_id,format,data,native,sha256,native_sha256) SELECT $1,id,0,1,'Quota','GB',rom_sha256,$2,1,$3,$4,$5,$6 FROM games WHERE id=ANY($7::uuid[])`,[owner,STATE_CORE,data,native,checksum(data),checksum(native),gameIds]);}
   await fill(player.id,ids.slice(0,29));
   assert.equal((await request(playPath(g,'/states/1'),{method:'PUT',session:player,body:payload})).status,507);
   await pool.query('DELETE FROM save_states WHERE game_id=ANY($1::uuid[])',[ids]);
   for(let i=0;i<9;i++){const owner=randomUUID();await pool.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,'JOGADOR')",[owner,'quota_'+i,hash]);await fill(owner,ids.slice(i*27,(i+1)*27));}
   assert.equal((await request(playPath(g,'/states/1'),{method:'PUT',session:player,body:payload})).status,507);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM save_states WHERE user_id=$1 AND game_id=$2',[player.id,g.id])).rows[0].n,0);
  });

});
