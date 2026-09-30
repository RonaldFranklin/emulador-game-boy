import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import argon2 from 'argon2';
import pg from 'pg';
import { databaseConfig } from '../backend/dist/config.js';
import { migrate } from '../backend/dist/database/migrations.js';
import { bootstrapMasterFromEnv } from '../backend/dist/cli/bootstrap-env.js';
import { bootstrapFirstMaster, BOOTSTRAP_LOCK_KEY } from '../backend/dist/cli/bootstrap-common.js';

const name = `emulador_test_${randomBytes(10).toString('hex')}`;
const original = Object.fromEntries(['PGDATABASE', 'CATALOG_STORAGE_DIR', 'APP_ORIGIN', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'].map(key => [key, process.env[key]]));
const admin = new pg.Pool(databaseConfig());
const origin = 'http://127.0.0.1:5173';
const secrets = new Set();
let ownsDatabase = false;
let pool;
let directory;
let app;

function credentials() {
  const password = ` X7_${randomBytes(18).toString('hex')}$HOME${'${NOT_INTERPOLATED}'}# literal `;
  secrets.add(password);
  return { username: `first_${randomBytes(8).toString('hex')}`, password };
}

async function envFile(content) {
  const path = join(directory, `${randomUUID()}.env`);
  await writeFile(path, content, { mode: 0o600, flag: 'wx' });
  return path;
}

function envContents({ username, password }) {
  return `IGNORED_VALUE=irrelevant\nADMIN_USERNAME=${username}\nADMIN_PASSWORD='${password}'\n`;
}

async function usersFingerprint() {
  return (await pool.query("SELECT md5(coalesce(string_agg(row_to_json(u)::text, '' ORDER BY id), '')) AS hash FROM users u")).rows[0].hash;
}

async function cli(path) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['backend/dist/cli/bootstrap-master-env.js'], {
      env: { ...process.env, BOOTSTRAP_ENV_FILE: path }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  for (const secret of secrets) assert.ok(!result.output.includes(secret), 'O comando nunca deve imprimir uma senha.');
  return result;
}

async function startApp() {
  const { createApp } = await import('../backend/dist/app.js');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
}

async function login(account) {
  const response = await fetch(`${await app.getUrl()}/api/auth/login`, {
    method: 'POST', headers: { Origin: origin, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' },
    body: JSON.stringify(account),
  });
  assert.equal(response.status, 200, 'Credenciais exatas do arquivo devem autenticar.');
  const identity = await response.json();
  assert.equal(identity.user.role, 'MASTER');
  assert.equal(identity.user.mustChangePassword, false);
  assert.equal(identity.user.blocked, false);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
  return { user: identity.user, cookie: response.headers.get('set-cookie').split(';', 1)[0] };
}

describe('Primeiro master por arquivo .env em PostgreSQL isolado', { concurrency: false }, () => {
  before(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    ownsDatabase = true;
    directory = await mkdtemp(join(tmpdir(), 'emulador-bootstrap-env-'));
    process.env.PGDATABASE = name;
    process.env.CATALOG_STORAGE_DIR = join(directory, 'catalog');
    process.env.APP_ORIGIN = origin;
    pool = new pg.Pool(databaseConfig());
    await migrate(pool);
  });

  beforeEach(async () => {
    await app?.close();
    app = undefined;
    // This database was created by this suite; no development row is touched.
    await pool.query('TRUNCATE users, login_attempts CASCADE');
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
  });

  after(async () => {
    try {
      try { await app?.close(); } finally { await pool?.end(); }
      if (ownsDatabase) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
      if (directory) await rm(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  test('CLI cria master com Argon2id, mantém $ e espaços literais e permite login após reinício', async () => {
    const account = credentials();
    const file = await envFile(envContents(account));
    assert.equal((await cli(file)).code, 0);
    const row = (await pool.query('SELECT * FROM users')).rows[0];
    assert.equal(row.username, account.username);
    assert.ok(row.password_hash.startsWith('$argon2id$'), 'Hash deve usar Argon2id.');
    assert.ok(await argon2.verify(row.password_hash, account.password), 'Senha literal deve corresponder ao hash.');
    const params = Object.fromEntries(row.password_hash.split('$')[3].split(',').map(value => value.split('=')));
    assert.deepEqual(params, { m: '65536', t: '3', p: '1' });
    await startApp();
    const session = await login(account);
    const before = await usersFingerprint();
    await app.close();
    app = undefined;
    const replacement = credentials();
    await writeFile(file, envContents(replacement), { mode: 0o600 });
    assert.equal((await cli(file)).code, 0);
    assert.equal(await usersFingerprint(), before, 'Reinício não redefine, renomeia nem cria outro master.');
    await startApp();
    assert.equal((await login(account)).user.id, session.user.id);
    const me = await fetch(`${await app.getUrl()}/api/auth/me`, { headers: { Cookie: session.cookie } });
    assert.equal(me.status, 200, 'Bootstrap idempotente preserva a sessão existente.');
  });

  test('sem master, arquivo ausente e configurações vazias, parciais ou inválidas falham sem criar contas', async () => {
    const account = credentials();
    const configurations = [
      '', 'ADMIN_USERNAME=\nADMIN_PASSWORD=\n', `ADMIN_USERNAME=${account.username}\n`,
      `ADMIN_PASSWORD='${account.password}'\n`, envContents({ ...account, username: 'Invalid User' }),
      envContents({ ...account, username: 'ab' }), envContents({ ...account, password: 'x'.repeat(11) }),
      envContents({ ...account, password: 'x'.repeat(129) }),
      `ADMIN_USERNAME=${account.username}\nADMIN_PASSWORD=unquoted-long-password\n`,
      `ADMIN_USERNAME=${account.username}\nADMIN_PASSWORD="double-quoted-password"\n`,
      `ADMIN_USERNAME=${account.username}\n` + String.raw`ADMIN_PASSWORD='long-valid-value\'extra'` + '\n',
      `ADMIN_USERNAME=${account.username}\nADMIN_PASSWORD='long-valid\nmultiline-password'\n`,
      envContents(account) + `ADMIN_PASSWORD='another-long-password'\n`,
      envContents(account) + `ADMIN_USERNAME=${account.username}\n`,
      `ADMIN_USERNAME=${account.username}\nADMIN_PASSWORD='long-valid-password'trailing\n`,
      `ADMIN_USERNAME=${account.username}\n` + String.raw`ADMIN_PASSWORD='long-valid-password\'` + '\n',
    ];
    const files = [join(directory, 'missing.env')];
    for (const content of configurations) files.push(await envFile(content));
    for (const path of files) {
      await assert.rejects(bootstrapMasterFromEnv(pool, path));
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count, 0);
    }
    assert.notEqual((await cli(files[0])).code, 0, 'CLI precisa sinalizar falha de configuração.');
  });

  test('valores ADMIN no ambiente do processo não substituem o arquivo secreto ausente', async () => {
    const account = credentials();
    process.env.ADMIN_USERNAME = account.username;
    process.env.ADMIN_PASSWORD = account.password;
    await assert.rejects(bootstrapMasterFromEnv(pool, join(directory, 'absent.env')));
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count, 0);
  });

  test('master existente torna bootstrap um no-op antes de ler ou validar arquivo, preservando todos os campos', async () => {
    const account = credentials();
    await bootstrapMasterFromEnv(pool, await envFile(envContents(account)));
    // MASTER blocking is forbidden by the existing database CHECK constraint.
    await pool.query("UPDATE users SET must_change_password=true WHERE role='MASTER'");
    const before = await usersFingerprint();
    const paths = [join(directory, 'never-created.env'), directory,
      await envFile('ADMIN_USERNAME=!\nADMIN_PASSWORD=x\n'), await envFile(envContents(account) + 'ADMIN_PASSWORD=invalidduplicate\n')];
    for (const path of paths) assert.equal(await bootstrapMasterFromEnv(pool, path), 'exists');
    assert.equal((await cli(paths[0])).code, 0);
    assert.equal(await usersFingerprint(), before);
  });

  test('jogador homônimo nunca é promovido, desbloqueado nem tem a senha redefinida', async () => {
    const account = credentials();
    const oldPassword = credentials().password;
    await pool.query("INSERT INTO users(id,username,password_hash,role,blocked,must_change_password) VALUES($1,$2,$3,'JOGADOR',true,true)",
      [randomUUID(), account.username, await argon2.hash(oldPassword)]);
    const before = await usersFingerprint();
    await assert.rejects(bootstrapMasterFromEnv(pool, await envFile(envContents(account))));
    assert.equal(await usersFingerprint(), before);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM users WHERE role='MASTER'")).rows[0].count, 0);
  });

  test('arquivo deve ser regular, limitado e não pode ser seguido por symlink', async () => {
    const real = await envFile(envContents(credentials()));
    const link = join(directory, 'linked.env');
    await symlink(real, link);
    for (const path of [directory, link, await envFile('x'.repeat(65537)), await envFile(Buffer.from([0xc0, 0xaf]))]) {
      await assert.rejects(bootstrapMasterFromEnv(pool, path));
    }
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count, 0);
  });

  test('inicializadores por arquivo concorrentes criam exatamente um master', async () => {
    const accounts = Array.from({ length: 6 }, credentials);
    const files = await Promise.all(accounts.map(account => envFile(envContents(account))));
    const results = await Promise.all(files.map(file => bootstrapMasterFromEnv(pool, file)));
    assert.equal(results.filter(result => result === 'created').length, 1);
    assert.equal(results.filter(result => result === 'exists').length, 5);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM users WHERE role='MASTER'")).rows[0].count, 1);
  });

  test('fluxos do CLI interativo e do arquivo disputam a mesma trava e não duplicam o primeiro master', async () => {
    const interactive = credentials();
    const automatic = credentials();
    const file = await envFile(envContents(automatic));
    const blocker = await pool.connect();
    let providerCalls = 0;
    let tasks;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);
      tasks = Promise.allSettled([
        bootstrapFirstMaster(pool, async () => { providerCalls += 1; return interactive; }, 'error'),
        bootstrapMasterFromEnv(pool, file),
      ]);
      const deadline = Date.now() + 5000;
      for (;;) {
        const waiting = (await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%pg_advisory_xact_lock%'")).rows[0].count;
        if (waiting >= 2) break;
        assert.ok(Date.now() < deadline, 'Ambos inicializadores devem aguardar a mesma trava.');
        await sleep(20);
      }
      await blocker.query('COMMIT');
      const results = await tasks;
      assert.equal(results.filter(result => result.status === 'fulfilled' && result.value === 'created').length, 1);
      assert.ok(providerCalls <= 1);
      const rows = (await pool.query('SELECT username,password_hash,role FROM users')).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].role, 'MASTER');
      const winner = rows[0].username === interactive.username ? interactive : automatic;
      assert.ok(await argon2.verify(rows[0].password_hash, winner.password));
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      await tasks;
    }
  });
});
