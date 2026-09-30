import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { run, compose } from './docker.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const suffix = randomBytes(10).toString('hex');
const database = `emulador_test_${suffix}`;
const container = `emulador-game-boy-operations-${suffix}`;
const origin = 'http://127.0.0.1:5173';
const masterUsername = `ops_master_${suffix.slice(0, 12)}`;
const playerUsername = `ops_player_${suffix.slice(0, 12)}`;
const secret = () => `A7!_${randomBytes(24).toString('base64url')}`;
const masterPassword = secret();
const temporaryPassword = secret();
const playerPassword = secret();
let ownsDatabase = false;
let ownsContainer = false;
let recoveredDatabase;
let recoveredVolume;
let baseUrl;

function redact(text) {
  for (const password of [masterPassword, temporaryPassword, playerPassword]) {
    text = text.replaceAll(password, '[senha omitida]');
  }
  return text;
}

function localCommand(program, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      const output = redact(`${stdout}\n${stderr}`);
      if (code !== 0) {
        const error = new Error(`Comando de validação falhou (${code}): ${output.trim()}`);
        error.output = output;
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
    // Test credentials travel only in an anonymous pipe to the PTY driver.
    child.stdin.end(input);
  });
}

async function sql(target, statement) {
  return run(compose('exec', '-T', '--user', 'postgres', 'database', 'psql',
    '-U', 'postgres', '-d', target, '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement), { quiet: true });
}

async function snapshot(target) {
  return JSON.parse(await sql(target,
    `SELECT json_build_object(
      'users', (SELECT count(*) FROM users),
      'sessions', (SELECT count(*) FROM sessions),
      'migrations', (SELECT count(*) FROM schema_migrations),
      'usersFingerprint', (SELECT md5(coalesce(string_agg(row_to_json(u)::text, '' ORDER BY id), '')) FROM users u)
    )`));
}

async function waitFor(label, check) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch { /* A restarting service is temporarily unavailable. */ }
    await sleep(500);
  }
  throw new Error(`${label} não ficou disponível em 30 segundos.`);
}

async function resolveApiAddress() {
  const published = await run(['port', container, '3001/tcp'], { quiet: true });
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  baseUrl = `http://${published}`;
}

async function request(path, { method = 'GET', body, session } = {}) {
  const headers = {};
  if (session) headers.Cookie = session.cookie;
  if (method !== 'GET') {
    headers.Origin = origin;
    headers['X-Requested-With'] = 'XMLHttpRequest';
    headers['Content-Type'] = 'application/json';
    if (session) headers['X-CSRF-Token'] = session.csrfToken;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : undefined };
}

async function login(username, password) {
  const result = await request('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(result.status, 200, 'Login operacional deve funcionar.');
  const cookie = result.headers.get('set-cookie');
  assert.ok(cookie?.startsWith('emulador_session='));
  assert.match(cookie, /;\s*HttpOnly/i);
  return { cookie: cookie.split(';')[0], csrfToken: result.data.csrfToken, user: result.data.user };
}

function recoveredName(output) {
  return output.match(/(?:NOVO banco|destino não ativado): (emulador_recovered_[a-f0-9]{20})\b/)?.[1];
}

async function verifyRecoveredApplication(target, oldSession) {
  // The normal backend service supplies PGUSER=emulador and the application
  // secret file. The test service's PostgreSQL administrator is not used here.
  // JavaScript on the command line contains no credentials; stdin is a pipe.
  const code = `
    import assert from 'node:assert/strict';
    import { createApp } from './backend/dist/app.js';
    assert.equal(process.env.PGUSER, 'emulador');
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const { username, password, oldCookie } = JSON.parse(input);
    input = '';
    const app = await createApp();
    try {
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      const old = await fetch(base + '/api/auth/me', { headers: { Cookie: oldCookie } });
      assert.equal(old.status, 401);
      const headers = {
        Origin: process.env.APP_ORIGIN,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json',
      };
      const login = await fetch(base + '/api/auth/login', {
        method: 'POST', headers, body: JSON.stringify({ username, password }),
      });
      assert.equal(login.status, 200);
      const identity = await login.json();
      assert.equal(identity.user.role, 'MASTER');
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const listed = await fetch(base + '/api/users', { headers: { Cookie: cookie } });
      assert.equal(listed.status, 200);
      assert.equal((await listed.json()).users.length, 2);
      const logout = await fetch(base + '/api/auth/logout', {
        method: 'POST',
        headers: { ...headers, Cookie: cookie, 'X-CSRF-Token': identity.csrfToken },
        body: '{}',
      });
      assert.equal(logout.status, 204);
      console.log('RESTORED_APP_ACCESS_OK');
    } finally {
      await app.close();
    }
  `;
  const output = await localCommand('docker', compose('run', '--rm', '--no-deps', '-T',
    '-e', `PGDATABASE=${target}`, '-e', `APP_ORIGIN=${origin}`, '-e', 'CATALOG_STORAGE_DIR=/tmp/emulador-operations-catalog', 'backend',
    'node', '--input-type=module', '-e', code), JSON.stringify({
      username: masterUsername, password: masterPassword, oldCookie: oldSession.cookie,
    }));
  assert.ok(output.includes('RESTORED_APP_ACCESS_OK'), 'O papel da aplicação deve autenticar no banco recuperado.');
}

try {
  const config = JSON.parse(await run(compose('config', '--format', 'json')));
  assert.equal(config.name, 'emulador-game-boy-dev', 'Este teste opera somente o Compose local do projeto.');
  await run(compose('exec', '-T', '--user', 'postgres', 'database', 'createdb',
    '-U', 'postgres', '--template=template0', '--owner=emulador', database), { quiet: true });
  ownsDatabase = true;
  await run(compose('run', '--rm', '--no-deps', '-T', '-e', `PGDATABASE=${database}`, 'test',
    'npm', 'run', 'migrate', '--workspace', 'backend'), { quiet: true });
  const bootstrap = JSON.parse(await localCommand('python3', ['tests/bootstrap-cli.py', database],
    JSON.stringify({ username: masterUsername, password: masterPassword })));
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.passwordEchoed, false);
  await run(compose('run', '--detach', '--no-deps', '--name', container,
    '--publish', '127.0.0.1::3001', '-e', `PGDATABASE=${database}`, '-e', `APP_ORIGIN=${origin}`,
    'test', 'npm', 'run', 'start', '--workspace', 'backend'), { quiet: true });
  ownsContainer = true;
  await resolveApiAddress();
  await waitFor('API isolada', async () => (await request('/api/health')).status === 200);

  const master = await login(masterUsername, masterPassword);
  const created = await request('/api/users', {
    method: 'POST', session: master, body: { username: playerUsername, password: temporaryPassword },
  });
  assert.equal(created.status, 201);
  const temporary = await login(playerUsername, temporaryPassword);
  assert.equal((await request('/api/auth/password', {
    method: 'POST', session: temporary,
    body: { currentPassword: temporaryPassword, newPassword: playerPassword },
  })).status, 204);
  const player = await login(playerUsername, playerPassword);
  const before = await snapshot(database);
  assert.equal(before.users, 2);
  assert.equal(before.sessions, 2);
  assert.ok(before.migrations >= 1);
  const beforeList = await request('/api/users', { session: master });
  assert.equal(beforeList.status, 200);
  assert.equal(beforeList.data.users.length, 2);
  console.log('Bootstrap sem eco e duas contas com sessões persistidas: validados.');

  // This intentionally restarts only this project's PostgreSQL service. The
  // suite must run separately from API/browser tests, as documented in README.
  await run(compose('restart', 'database'), { quiet: true });
  await waitFor('PostgreSQL', async () => {
    await run(compose('exec', '-T', '--user', 'postgres', 'database', 'pg_isready',
      '-h', '127.0.0.1', '-U', 'postgres', '-d', database), { quiet: true });
    return true;
  });
  await run(['restart', container], { quiet: true });
  await resolveApiAddress();
  await waitFor('API após reinício', async () => (await request('/api/health')).status === 200);
  for (const session of [master, player]) {
    const me = await request('/api/auth/me', { session });
    assert.equal(me.status, 200, 'Cookie emitido antes dos reinícios deve continuar válido.');
    assert.equal(me.data.user.id, session.user.id);
  }
  const afterList = await request('/api/users', { session: master });
  assert.equal(afterList.status, 200);
  assert.deepEqual(afterList.data, beforeList.data);
  const afterRestart = await snapshot(database);
  assert.deepEqual(afterRestart, before);
  console.log('Reinício real do PostgreSQL e da API: duas contas e duas sessões preservadas.');

  await mkdir('.local/backups', { recursive: true, mode: 0o700 });
  const backup = `.local/backups/operational-${suffix}.dump`;
  const file = await open(backup, 'wx', 0o600);
  try {
    await run(compose('exec', '-T', '--user', 'postgres', 'database', 'pg_dump',
      '-U', 'postgres', '-d', database, '--format=custom', '--no-owner', '--no-acl'), { output: file.fd, quiet: true });
  } finally { await file.close(); }
  const info = await stat(backup);
  assert.ok(info.size > 0);
  assert.equal(info.mode & 0o777, 0o600);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(backup)) hash.update(chunk);
  await writeFile(`${backup}.sha256`, `${hash.digest('hex')}\n`, { flag: 'wx', mode: 0o600 });
  const restoredOutput = await localCommand(process.execPath, ['scripts/restore-verify.mjs', backup]);
  const restoredLine = restoredOutput.split('\n').find((line) => line.startsWith('Restauração isolada validada'));
  assert.ok(restoredLine, 'Verificação deve informar a leitura do banco restaurado.');
  const restored = JSON.parse(restoredLine.slice(restoredLine.indexOf('{')));
  assert.deepEqual(restored, before, 'Backup restaurado deve preservar contas, sessões e conteúdo das contas.');
  console.log('Backup populado e restauração em container isolado: contagens e conteúdo conferidos.');

  const previouslyRecovered = new Set(JSON.parse(await sql('postgres',
    "SELECT coalesce(json_agg(datname), '[]'::json) FROM pg_database WHERE datname LIKE 'emulador_recovered_%'")));
  let recoveryOutput;
  try {
    recoveryOutput = await localCommand(process.execPath, ['scripts/restore-recover.mjs', backup]);
  } catch (error) {
    const partial = recoveredName(error.output ?? '');
    if (partial && !previouslyRecovered.has(partial)) recoveredDatabase = partial;
    throw error;
  }
  const candidate = recoveredName(recoveryOutput);
  assert.ok(candidate, 'Recuperação deve identificar a nova base.');
  assert.equal(previouslyRecovered.has(candidate), false, 'O destino da recuperação deve ser novo.');
  recoveredDatabase = candidate;
  recoveredVolume = recoveryOutput.match(/^CATALOG_VOLUME=(emulador-game-boy-recovered-[a-f0-9]{20})$/m)?.[1];
  assert.ok(recoveredVolume, 'Recuperação deve identificar seu novo volume.');
  const recovered = await snapshot(recoveredDatabase);
  assert.equal(recovered.users, 2);
  assert.equal(recovered.sessions, 0, 'Recuperação deve revogar todas as sessões importadas.');
  assert.equal(recovered.migrations, before.migrations);
  assert.equal(recovered.usersFingerprint, before.usersFingerprint);
  const owners = JSON.parse(await sql(recoveredDatabase,
    `SELECT json_build_object(
      'databaseOwner', (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()),
      'tableOwners', (SELECT json_agg(DISTINCT tableowner) FROM pg_tables WHERE schemaname = 'public')
    )`));
  assert.equal(owners.databaseOwner, 'emulador');
  assert.deepEqual(owners.tableOwners, ['emulador']);
  await verifyRecoveredApplication(recoveredDatabase, master);
  assert.deepEqual(await snapshot(recoveredDatabase), recovered,
    'Validação da aplicação deve encerrar sua sessão temporária sem alterar contas recuperadas.');
  assert.deepEqual(await snapshot(database), before, 'Recuperação não deve alterar a base de origem.');
  console.log('Recuperação em banco novo: duas contas íntegras, sessões revogadas e ownership emulador.');
  console.log('Backend com papel emulador: cookie antigo recusado, login original e administração funcionais.');
  console.log(`Teste operacional concluído. Evidência preservada: ${backup} e arquivo .sha256.`);
} finally {
  const failures = [];
  if (ownsContainer) {
    try { await run(['rm', '--force', container], { quiet: true }); }
    catch (error) { failures.push(error.message); }
  }
  // Names are generated by this run or returned by its own recovery command.
  // Existing databases, .env and all Docker volumes remain untouched.
  for (const name of [recoveredDatabase, ownsDatabase ? database : undefined].filter(Boolean)) {
    try {
      await run(compose('exec', '-T', '--user', 'postgres', 'database', 'dropdb',
        '-U', 'postgres', '--force', name), { quiet: true });
    } catch (error) { failures.push(error.message); }
  }
  if (recoveredVolume) {
    try { await run(['volume', 'rm', recoveredVolume], { quiet: true }); }
    catch (error) { failures.push(error.message); }
  }
  if (failures.length) throw new Error(`Limpeza dos recursos efêmeros incompleta: ${redact(failures.join('; '))}`);
}
