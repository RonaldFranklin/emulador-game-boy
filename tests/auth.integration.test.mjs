import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import argon2 from 'argon2';
import pg from 'pg';
import { databaseConfig } from '../backend/dist/config.js';

// Every run owns a fresh database. No test connects the application to the
// development database, truncates development data, or removes Docker volumes.
const databaseName = `emulador_test_${randomBytes(10).toString('hex')}`;
const originalDatabase = process.env.PGDATABASE;
const originalStorage = process.env.CATALOG_STORAGE_DIR;
const origin = 'http://127.0.0.1:5173';
const masterPassword = password();
const masterId = randomUUID();
const adminPool = new pg.Pool(databaseConfig());
let ownsDatabase = false;
let pool;
let app;
let createApp;
let baseUrl;
let master;
let storageDirectory;

function password() {
  return `A7!_${randomBytes(18).toString('base64url')}`;
}

function account(prefix) {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

function assertPublicUser(user) {
  assert.equal(typeof user.id, 'string');
  assert.equal(typeof user.username, 'string');
  assert.ok(['MASTER', 'JOGADOR'].includes(user.role));
  assert.equal(typeof user.blocked, 'boolean');
  assert.equal(typeof user.mustChangePassword, 'boolean');
  assert.equal(typeof user.createdAt, 'string');
  for (const key of Object.keys(user)) {
    assert.doesNotMatch(key, /password_hash|passwordHash|token|secret/i);
  }
  assert.equal(user.password, undefined);
}

async function request(path, options = {}) {
  const { method = 'GET', body, session, headers: overrides = {} } = options;
  const headers = { ...overrides };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (!Object.hasOwn(headers, 'Origin')) headers.Origin = origin;
    if (!Object.hasOwn(headers, 'X-Requested-With')) headers['X-Requested-With'] = 'XMLHttpRequest';
    if (session?.csrfToken && !Object.hasOwn(headers, 'X-CSRF-Token')) {
      headers['X-CSRF-Token'] = session.csrfToken;
    }
  }
  if (session?.cookie) headers.Cookie = session.cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // A null header is an explicit request to omit it, for CSRF/origin tests.
  for (const key of Object.keys(headers)) {
    if (headers[key] === null) delete headers[key];
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}),
    redirect: 'manual',
  });
  const content = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    data: content ? JSON.parse(content) : undefined,
  };
}

async function login(username, secret, expectedStatus = 200) {
  const response = await request('/api/auth/login', {
    method: 'POST',
    body: { username, password: secret },
  });
  assert.equal(response.status, expectedStatus, `login status for ${username}`);
  if (expectedStatus !== 200) return response;
  assertPublicUser(response.data.user);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie?.startsWith('emulador_session='));
  assert.match(setCookie, /;\s*HttpOnly/i);
  assert.match(setCookie, /;\s*SameSite=(Strict|Lax)/i);
  assert.match(setCookie, /;\s*Path=\//i);
  assert.match(setCookie, /;\s*(Max-Age|Expires)=/i);
  assert.equal(typeof response.data.csrfToken, 'string');
  assert.ok(response.data.csrfToken.length >= 32);
  return {
    cookie: setCookie.split(';')[0],
    csrfToken: response.data.csrfToken,
    user: response.data.user,
  };
}

async function createPlayer(prefix, { activate = true } = {}) {
  const username = account(prefix);
  const temporaryPassword = password();
  const result = await request('/api/users', {
    method: 'POST',
    session: master,
    body: { username, password: temporaryPassword },
  });
  assert.equal(result.status, 201);
  assertPublicUser(result.data.user);
  assert.equal(result.data.user.role, 'JOGADOR');
  assert.equal(result.data.user.mustChangePassword, true);
  assert.equal(result.data.user.blocked, false);
  const player = { user: result.data.user, username, temporaryPassword };
  if (!activate) return player;
  const temporarySession = await login(username, temporaryPassword);
  const permanentPassword = password();
  const changed = await request('/api/auth/password', {
    method: 'POST',
    session: temporarySession,
    body: { currentPassword: temporaryPassword, newPassword: permanentPassword },
  });
  assert.equal(changed.status, 204);
  return { ...player, password: permanentPassword, session: await login(username, permanentPassword) };
}

async function startApp() {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}

async function waitForUserLockWaiters(minimum) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT count(*)::integer AS count FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query = $1`,
      ['SELECT * FROM users WHERE id = $1 FOR UPDATE'],
    );
    if (result.rows[0].count >= minimum) return;
    await sleep(20);
  }
  assert.fail(`Esperava ${minimum} operações aguardando o lock da conta.`);
}

describe('Autenticação e autorização com PostgreSQL isolado', { concurrency: false }, () => {
  before(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    ownsDatabase = true;
    process.env.PGDATABASE = databaseName;
    process.env.APP_ORIGIN = origin;
    process.env.NODE_ENV = 'test';
    storageDirectory = await mkdtemp(join(tmpdir(), 'emulador-auth-catalog-'));
    process.env.CATALOG_STORAGE_DIR = storageDirectory;
    pool = new pg.Pool(databaseConfig());
    const { migrate } = await import('../backend/dist/database/migrations.js');
    await migrate(pool);
    // Running migrations twice must be safe for an existing database.
    await migrate(pool);
    const hash = await argon2.hash(masterPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
    await pool.query(
      `INSERT INTO users (id, username, password_hash, role, blocked, must_change_password)
       VALUES ($1, $2, $3, 'MASTER', false, false)`,
      [masterId, 'master_test', hash],
    );
    ({ createApp } = await import('../backend/dist/app.js'));
    await startApp();
    master = await login('master_test', masterPassword);
  });

  // Independent scenarios must not consume one another's login quota. Isolated DB only.
  beforeEach(async () => { await pool.query('DELETE FROM login_attempts'); });

  after(async () => {
    try {
      if (app) await app.close();
      if (pool) await pool.end();
      if (ownsDatabase) {
        await adminPool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      }
    } finally {
      await adminPool.end();
      if (storageDirectory) await rm(storageDirectory, { recursive: true, force: true });
      if (originalDatabase === undefined) delete process.env.PGDATABASE;
      else process.env.PGDATABASE = originalDatabase;
      if (originalStorage === undefined) delete process.env.CATALOG_STORAGE_DIR;
      else process.env.CATALOG_STORAGE_DIR = originalStorage;
    }
  });

  test('health verifica banco; recursos protegidos exigem sessão', async () => {
    assert.equal((await request('/api/health')).status, 200);
    for (const path of ['/api/auth/me', '/api/users', '/api/games']) {
      assert.equal((await request(path)).status, 401, path);
    }
    assert.equal((await request('/api/auth/logout', { method: 'POST' })).status, 401);
    const forged = { cookie: `emulador_session=${randomBytes(32).toString('base64url')}` };
    assert.equal((await request('/api/auth/me', { session: forged })).status, 401);
    const me = await request('/api/auth/me', { session: master });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.id, masterId);
    assertPublicUser(me.data.user);
    const games = await request('/api/games', { session: master });
    assert.equal(games.status, 200);
    assert.deepEqual(games.data, { games: [] });
  });

  test('origem, cabeçalho de AJAX e CSRF são obrigatórios nas mutações', async () => {
    for (const headers of [
      { Origin: null },
      { Origin: 'https://origem-invalida.example' },
      { 'X-Requested-With': null },
      { 'X-Requested-With': 'invalid' },
    ]) {
      const response = await request('/api/auth/login', {
        method: 'POST',
        body: { username: 'master_test', password: masterPassword },
        headers,
      });
      assert.equal(response.status, 403);
    }
    for (const headers of [
      { 'X-CSRF-Token': null },
      { 'X-CSRF-Token': randomBytes(32).toString('base64url') },
      { Origin: 'http://127.0.0.1:5173.evil.example' },
    ]) {
      const response = await request('/api/auth/logout', {
        method: 'POST', session: master, headers,
      });
      assert.equal(response.status, 403);
    }
    assert.equal((await request('/api/auth/me', { session: master })).status, 200);
  });

  test('CSRF não ASCII com mesmo comprimento JavaScript e mais bytes retorna 403 sem encerrar a sessão', async () => {
    const unicodeToken = 'é'.repeat(master.csrfToken.length);
    assert.equal(unicodeToken.length, master.csrfToken.length);
    assert.notEqual(Buffer.byteLength(unicodeToken, 'utf8'), Buffer.byteLength(master.csrfToken, 'utf8'));
    const response = await request('/api/auth/logout', {
      method: 'POST',
      session: master,
      headers: { 'X-CSRF-Token': unicodeToken },
    });
    assert.equal(response.status, 403);
    const me = await request('/api/auth/me', { session: master });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.id, masterId);
  });

  test('validação estrita rejeita payload malformado, campos de privilégio e duplicatas', async () => {
    for (const body of [
      { username: 'nome inválido', password: password() },
      { username: account('role'), password: password(), role: 'MASTER' },
      { username: account('hash'), password: password(), passwordHash: 'injetado' },
      { username: ['array'], password: password() },
    ]) {
      assert.equal((await request('/api/users', {
        method: 'POST', session: master, body,
      })).status, 400);
    }
    const duplicate = await createPlayer('duplicate', { activate: false });
    assert.equal((await request('/api/users', {
      method: 'POST', session: master,
      body: { username: duplicate.username, password: password() },
    })).status, 409);
    assert.equal((await request('/api/auth/login', {
      method: 'POST', body: { username: 'master_test', password: masterPassword, role: 'MASTER' },
    })).status, 400);
  });

  test('erros de login não distinguem conta inexistente de senha incorreta', async () => {
    const unknown = await login(account('missing'), password(), 401);
    const wrongPassword = await login('master_test', password(), 401);
    assert.deepEqual(unknown.data, wrongPassword.data);
    assert.equal(unknown.headers.get('set-cookie'), null);
    assert.equal(wrongPassword.headers.get('set-cookie'), null);
  });

  test('senha legada curta permite login e troca, preservando os limites para credenciais e senhas novas', async () => {
    const id = randomUUID();
    const username = account('legacy');
    const shortPassword = randomBytes(3).toString('hex');
    const hash = await argon2.hash(shortPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
    // Only this isolated fixture bypasses the policy for creating new passwords.
    await pool.query(
      `INSERT INTO users (id, username, password_hash, role, blocked, must_change_password)
       VALUES ($1, $2, $3, 'JOGADOR', false, false)`,
      [id, username, hash],
    );
    const session = await login(username, shortPassword);
    const anotherSession = await login(username, shortPassword);
    assert.equal(session.user.id, id);

    assert.equal((await request('/api/users', {
      method: 'POST', session: master,
      body: { username: account('short'), password: shortPassword },
    })).status, 400);
    assert.equal((await request(`/api/users/${id}/reset-password`, {
      method: 'POST', session: master, body: { password: shortPassword },
    })).status, 400);
    assert.equal((await request('/api/auth/password', {
      method: 'POST', session,
      body: { currentPassword: shortPassword, newPassword: randomBytes(4).toString('hex') },
    })).status, 400);

    for (const invalidPassword of ['', randomBytes(65).toString('hex')]) {
      await login(username, invalidPassword, 400);
      assert.equal((await request('/api/auth/password', {
        method: 'POST', session,
        body: { currentPassword: invalidPassword, newPassword: password() },
      })).status, 400);
    }
    assert.equal((await request('/api/auth/me', { session })).status, 200);
    const newPassword = password();
    assert.equal((await request('/api/auth/password', {
      method: 'POST', session,
      body: { currentPassword: shortPassword, newPassword },
    })).status, 204);
    for (const revokedSession of [session, anotherSession]) {
      assert.equal((await request('/api/auth/me', { session: revokedSession })).status, 401);
    }
    await login(username, shortPassword, 401);
    const renewed = await login(username, newPassword);
    assert.equal(renewed.user.id, id);
    assert.equal(renewed.user.mustChangePassword, false);
  });

  test('senha temporária restringe acesso até a troca, que revoga a sessão', async () => {
    const player = await createPlayer('temporary', { activate: false });
    const session = await login(player.username, player.temporaryPassword);
    assert.equal(session.user.mustChangePassword, true);
    assert.equal((await request('/api/auth/me', { session })).status, 200);
    assert.equal((await request('/api/games', { session })).status, 403);
    assert.equal((await request('/api/users', { session })).status, 403);
    const newPassword = password();
    assert.equal((await request('/api/auth/password', {
      method: 'POST', session,
      body: { currentPassword: player.temporaryPassword, newPassword },
    })).status, 204);
    assert.equal((await request('/api/auth/me', { session })).status, 401);
    await login(player.username, player.temporaryPassword, 401);
    const renewed = await login(player.username, newPassword);
    assert.equal(renewed.user.mustChangePassword, false);
    assert.deepEqual((await request('/api/games', { session: renewed })).data, { games: [] });
  });

  test('jogador não lista nem altera outras contas; CSRF pertence à própria sessão', async () => {
    const alice = await createPlayer('alice');
    const bob = await createPlayer('bob');
    assert.equal((await request('/api/users', { session: alice.session })).status, 403);
    assert.equal((await request('/api/users', {
      method: 'POST', session: alice.session,
      body: { username: account('forbidden'), password: password() },
    })).status, 403);
    assert.equal((await request(`/api/users/${bob.user.id}/status`, {
      method: 'PATCH', session: alice.session, body: { blocked: true },
    })).status, 403);
    assert.equal((await request(`/api/users/${bob.user.id}/reset-password`, {
      method: 'POST', session: alice.session, body: { password: password() },
    })).status, 403);
    assert.equal((await request('/api/auth/password', {
      method: 'POST', session: alice.session,
      body: { currentPassword: alice.password, newPassword: password(), userId: bob.user.id },
    })).status, 400);
    assert.equal((await request('/api/auth/logout', {
      method: 'POST', session: alice.session,
      headers: { 'X-CSRF-Token': bob.session.csrfToken },
    })).status, 403);
    const me = await request('/api/auth/me', { session: alice.session });
    assert.equal(me.data.user.id, alice.user.id);
    assert.equal((await request('/api/auth/me', { session: bob.session })).status, 200);
    const list = await request('/api/users', { session: master });
    assert.equal(list.status, 200);
    list.data.users.forEach(assertPublicUser);
    assert.ok(list.data.users.some((user) => user.id === alice.user.id));
    assert.ok(list.data.users.some((user) => user.id === bob.user.id));
  });

  test('logout revoga a sessão atual; alteração de senha revoga todos os aparelhos', async () => {
    const player = await createPlayer('revoke');
    const otherSession = await login(player.username, player.password);
    assert.notEqual(otherSession.cookie, player.session.cookie);
    assert.notEqual(otherSession.csrfToken, player.session.csrfToken);
    assert.equal((await request('/api/auth/logout', {
      method: 'POST', session: player.session,
    })).status, 204);
    assert.equal((await request('/api/auth/me', { session: player.session })).status, 401);
    assert.equal((await request('/api/auth/me', { session: otherSession })).status, 200);
    const thirdSession = await login(player.username, player.password);
    assert.equal((await request('/api/auth/password', {
      method: 'POST', session: otherSession,
      body: { currentPassword: password(), newPassword: password() },
    })).status, 400);
    assert.equal((await request('/api/auth/me', { session: thirdSession })).status, 200);
    const newPassword = password();
    assert.equal((await request('/api/auth/password', {
      method: 'POST', session: otherSession,
      body: { currentPassword: player.password, newPassword },
    })).status, 204);
    for (const session of [otherSession, thirdSession]) {
      assert.equal((await request('/api/auth/me', { session })).status, 401);
    }
    await login(player.username, player.password, 401);
    assert.equal((await login(player.username, newPassword)).user.mustChangePassword, false);
  });

  test('redefinição administrativa revoga sessões e exige nova troca de senha', async () => {
    const player = await createPlayer('reset');
    const another = await login(player.username, player.password);
    const temporaryPassword = password();
    assert.equal((await request(`/api/users/${player.user.id}/reset-password`, {
      method: 'POST', session: master, body: { password: temporaryPassword },
    })).status, 204);
    for (const session of [player.session, another]) {
      assert.equal((await request('/api/auth/me', { session })).status, 401);
    }
    await login(player.username, player.password, 401);
    const temporary = await login(player.username, temporaryPassword);
    assert.equal(temporary.user.mustChangePassword, true);
    assert.equal((await request('/api/games', { session: temporary })).status, 403);
    assert.equal((await request('/api/auth/me', { session: master })).status, 200);
  });

  test('bloqueio revoga todos os aparelhos; desbloqueio não reativa cookies antigos', async () => {
    const player = await createPlayer('blocked');
    const another = await login(player.username, player.password);
    const blocked = await request(`/api/users/${player.user.id}/status`, {
      method: 'PATCH', session: master, body: { blocked: true },
    });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.data.user.blocked, true);
    for (const session of [player.session, another]) {
      assert.equal((await request('/api/auth/me', { session })).status, 401);
    }
    await login(player.username, player.password, 401);
    assert.equal((await request(`/api/users/${player.user.id}/status`, {
      method: 'PATCH', session: master, body: { blocked: false },
    })).status, 200);
    assert.equal((await request('/api/auth/me', { session: another })).status, 401);
    assert.equal((await login(player.username, player.password)).user.blocked, false);
  });

  test('último master permanece acessível e não existe endpoint de exclusão', async () => {
    const blocked = await request(`/api/users/${masterId}/status`, {
      method: 'PATCH', session: master, body: { blocked: true },
    });
    assert.equal(blocked.status, 409);
    assert.equal((await request(`/api/users/${masterId}`, {
      method: 'DELETE', session: master,
    })).status, 404);
    assert.equal((await request('/api/auth/me', { session: master })).status, 200);
    const record = await pool.query('SELECT blocked FROM users WHERE id = $1', [masterId]);
    assert.equal(record.rows[0].blocked, false);
  });

  for (const action of ['reset-password', 'status']) {
    test(`login concorrente com ${action} não recria sessão revogada`, async () => {
      const player = await createPlayer(action === 'status' ? 'raceblock' : 'racereset');
      const temporaryPassword = password();
      const lock = await pool.connect();
      let mutation;
      let pendingLogin;
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [player.user.id]);
        // Queue the real admin endpoint first. PostgreSQL's row-lock queue then
        // makes its reset/block commit before the login's final locked check.
        mutation = request(`/api/users/${player.user.id}/${action}`, {
          method: action === 'status' ? 'PATCH' : 'POST',
          session: master,
          body: action === 'status' ? { blocked: true } : { password: temporaryPassword },
        });
        await waitForUserLockWaiters(1);
        pendingLogin = request('/api/auth/login', {
          method: 'POST', body: { username: player.username, password: player.password },
        });
        await waitForUserLockWaiters(2);
        await lock.query('COMMIT');
        const [changed, rejected] = await Promise.all([mutation, pendingLogin]);
        assert.equal(changed.status, action === 'status' ? 200 : 204);
        assert.equal(rejected.status, 401);
        assert.equal(rejected.headers.get('set-cookie'), null);
      } finally {
        await lock.query('ROLLBACK').catch(() => undefined);
        lock.release();
        await Promise.allSettled([mutation, pendingLogin].filter(Boolean));
      }
      assert.equal((await request('/api/auth/me', { session: player.session })).status, 401);
      const remaining = await pool.query('SELECT count(*)::integer AS count FROM sessions WHERE user_id = $1', [player.user.id]);
      assert.equal(remaining.rows[0].count, 0);
      if (action === 'reset-password') {
        assert.equal((await login(player.username, temporaryPassword)).user.mustChangePassword, true);
      }
    });
  }

  test('banco armazena Argon2id e somente hash do identificador de sessão', async () => {
    const player = await createPlayer('storage');
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [player.user.id]);
    const hash = result.rows[0].password_hash;
    const hashFields = hash.split('$');
    assert.equal(hashFields[1], 'argon2id');
    assert.equal(hashFields[2], 'v=19');
    const parameters = Object.fromEntries(hashFields[3].split(',').map((parameter) => parameter.split('=')));
    assert.deepEqual(parameters, { m: '65536', t: '3', p: '1' });
    assert.notEqual(hash, player.password);
    assert.equal(await argon2.verify(hash, player.password), true);
    const rawToken = player.session.cookie.split('=')[1];
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const sessions = await pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [player.user.id]);
    assert.ok(sessions.rows.some((row) => row.token_hash === tokenHash));
    assert.ok(sessions.rows.every((row) => row.token_hash !== rawToken));
  });

  test('usuários e sessões persistem quando a aplicação reinicia; sessão expirada é rejeitada', async () => {
    const player = await createPlayer('persistent');
    await app.close();
    app = undefined;
    await startApp();
    const me = await request('/api/auth/me', { session: player.session });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.id, player.user.id);
    assert.equal((await request('/api/users', { session: master })).status, 200);
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [player.user.id]);
    assert.equal((await request('/api/auth/me', { session: player.session })).status, 401);
    assert.equal((await login(player.username, player.password)).user.id, player.user.id);
  });

  test('limitação por conta persiste após reinício e libera após expirar a janela', async () => {
    const player = await createPlayer('limited');
    await pool.query('DELETE FROM login_attempts');
    await pool.query('INSERT INTO login_attempts(key,attempts,window_start) VALUES($1,10,now())',
      [createHash('sha256').update(`username:${player.username}`).digest('hex')]);
    await login(player.username, player.password, 429);
    await app.close();
    app = undefined;
    await startApp();
    await login(player.username, player.password, 429);
    await pool.query("UPDATE login_attempts SET window_start = now() - interval '901 seconds'");
    assert.equal((await login(player.username, player.password)).user.id, player.user.id);
  });

  test('limite por IP abrange contas diferentes e ignora X-Forwarded-For forjado', async () => {
    await pool.query('DELETE FROM login_attempts');
    await login('master_test', masterPassword);
    // Successful login preserves the independent IP attempt bucket.
    // Move that persisted counter to its boundary without 100 expensive hashes.
    await pool.query('UPDATE login_attempts SET attempts = 100 WHERE key = $1',
      [createHash('sha256').update('ip:127.0.0.1').digest('hex')]);
    await login(account('unknown'), password(), 429);
    const forged = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'master_test', password: masterPassword },
      headers: { 'X-Forwarded-For': '203.0.113.40' },
    });
    assert.equal(forged.status, 429);
  });
});
