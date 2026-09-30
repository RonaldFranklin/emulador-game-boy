import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--configured-first')) {
  console.error('Uso: node scripts/test-first-boot.mjs [--configured-first]');
  process.exit(2);
}
const configuredFirst = args[0] === '--configured-first';

// This fresh installation owns its source copy, Compose project, ports and
// volumes. It never loads the real project's .env or connects to its database.
const root = fileURLToPath(new URL('..', import.meta.url));
const suffix = randomBytes(10).toString('hex');
const project = `emulador-game-boy-firstboot-${suffix}`;
const directory = join(root, '.local', `firstboot-${suffix}`);
const envPath = join(directory, '.env');
let interpolationFile = envPath;
const catalogVolume = `${project}_catalog_data`;
const volumes = [`${project}_postgres_data`, catalogVolume];
const original = { username: `boot_${randomBytes(8).toString('hex')}`, password: `T7_${randomBytes(20).toString('hex')}$HOME${'${KEEP_LITERAL}'}#` };
const replacement = { username: `other_${randomBytes(8).toString('hex')}`, password: `R8_${randomBytes(20).toString('hex')}$NOT_EXPANDED` };
const privateValues = [original.password, replacement.password, original.username, replacement.username];
const childEnvironment = { ...process.env };
for (const key of ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'APP_ORIGIN', 'WEB_PORT', 'APP_DB_NAME', 'SESSION_TTL_HOURS', 'CATALOG_VOLUME', 'BOOTSTRAP_ENV_FILE', 'BOOTSTRAP_ENV_SOURCE', 'COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES']) delete childEnvironment[key];
const evidence = { project, mode: configuredFirst ? 'configured-first' : 'unconfigured-first', startedAt: new Date().toISOString(), passed: false, checks: [] };
let reservedPort;
let origin;
let started = false;
let ownsDirectory = false;
let failure;

function sanitize(value) {
  let output = String(value);
  for (const secret of privateValues) if (secret) output = output.replaceAll(secret, '[valor privado omitido]');
  return output;
}

function command(program, args, { input, allowFailure = false, cwd = directory } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: childEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0 && !allowFailure) reject(new Error(`Comando de primeiro boot falhou (${code}): ${sanitize(stderr || stdout).trim()}`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const compose = (...args) => ['compose', '-p', project, '--project-directory', directory,
  '--env-file', interpolationFile, '-f', join(directory, 'compose.yaml'), ...args];

function noPrivateValues(text, label) {
  for (const value of privateValues) assert.ok(!text.includes(value), `${label} não pode conter credenciais.`);
}

async function writeConfig(account) {
  const content = [
    `APP_ORIGIN=${origin}`, `WEB_PORT=${new URL(origin).port}`, 'APP_DB_NAME=emulador',
    'SESSION_TTL_HOURS=168', `CATALOG_VOLUME=${catalogVolume}`, 'BOOTSTRAP_ENV_SOURCE=./.env',
    ...(account ? [`ADMIN_USERNAME='${account.username}'`, `ADMIN_PASSWORD='${account.password}'`] : []), '',
  ].join('\n');
  // Editors commonly replace the inode; exercise Docker's secret bind with
  // that behavior instead of updating an already mounted file in place.
  const temporaryPath = join(directory, `.env-${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temporaryPath, content, { mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, envPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
}

async function waitFor(label, check) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* Service startup/restart is transient. */ }
    await sleep(500);
  }
  throw new Error(`${label} não ficou pronto em 90 segundos.`);
}

async function sql(statement) {
  return (await command('docker', compose('exec', '-T', '--user', 'postgres', 'database',
    'psql', '-U', 'postgres', '-d', 'emulador', '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement))).stdout.trim();
}

async function snapshot() {
  return JSON.parse(await sql(`SELECT json_build_object(
    'users',(SELECT count(*) FROM users),
    'masters',(SELECT count(*) FROM users WHERE role='MASTER'),
    'migrations',(SELECT count(*) FROM schema_migrations),
    'fingerprint',(SELECT md5(coalesce(string_agg(row_to_json(u)::text,'' ORDER BY id),'')) FROM users u))`));
}

async function request(path, { account, cookie } = {}) {
  return fetch(`${origin}${path}`, { method: account ? 'POST' : 'GET',
    headers: account ? { Origin: origin, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' }
      : cookie ? { Cookie: cookie } : {},
    ...(account ? { body: JSON.stringify(account) } : {}), signal: AbortSignal.timeout(5000) });
}

async function login(account) {
  const response = await request('/api/auth/login', { account });
  assert.equal(response.status, 200, 'Credenciais literais escolhidas devem autenticar.');
  const body = await response.json();
  assert.equal(body.user.role, 'MASTER');
  assert.equal(body.user.mustChangePassword, false);
  assert.equal(body.user.blocked, false);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  return { userId: body.user.id, cookie: cookie.split(';', 1)[0] };
}

async function inspectConfidentiality() {
  const configText = (await command('docker', compose('config', '--format', 'json'))).stdout;
  noPrivateValues(configText, 'Compose config');
  const config = JSON.parse(configText);
  assert.equal(config.name, project);
  assert.equal(config.volumes.catalog_data.name, catalogVolume);
  assert.equal(config.volumes.postgres_data.name, volumes[0]);
  assert.equal(config.services.database.ports, undefined);
  assert.ok(config.services.frontend.ports.every(port => port.host_ip === '127.0.0.1'));
  for (const [name, service] of Object.entries(config.services)) {
    assert.ok(!Object.keys(service.environment ?? {}).some(key => /^ADMIN_(USERNAME|PASSWORD)$/.test(key)), 'Credenciais não são variáveis do container.');
    if (name !== 'bootstrap') assert.ok(!(service.secrets ?? []).some(secret => secret.source === 'bootstrap_env'), 'Somente bootstrap pode montar a .env privada.');
    noPrivateValues(JSON.stringify(service.build ?? {}), 'Configuração de build');
  }
  if (started) {
    const ids = (await command('docker', compose('ps', '-a', '-q'))).stdout.trim().split(/\s+/).filter(Boolean);
    assert.ok(ids.length >= 5);
    const inspected = (await command('docker', ['inspect', ...ids])).stdout;
    noPrivateValues(inspected, 'Docker inspect');
    const records = JSON.parse(inspected);
    for (const record of records) {
      assert.equal(record.Config.Labels['com.docker.compose.project'], project);
      assert.ok(!record.Config.Env.some(value => /^ADMIN_(USERNAME|PASSWORD)=/.test(value)));
      const service = record.Config.Labels['com.docker.compose.service'];
      if (service !== 'bootstrap') assert.ok(!record.Mounts.some(mount => mount.Source === envPath));
    }
    const logs = await command('docker', compose('logs', '--no-color'));
    noPrivateValues(`${logs.stdout}\n${logs.stderr}`, 'Logs dos serviços');
    const images = [...new Set(records.map(record => record.Config.Image))];
    noPrivateValues((await command('docker', ['image', 'inspect', ...images])).stdout, 'Metadados das imagens');
    // Anonymous stdin carries test-only values; neither argv nor environment
    // contains them. Scan the actual frontend sources, build and runtime assets.
    const scan = `
      import {readdir,readFile} from 'node:fs/promises';
      import {join} from 'node:path';
      let input='';for await(const chunk of process.stdin)input+=chunk;
      const values=JSON.parse(input);input='';let files=0;
      async function visit(path){for(const item of await readdir(path,{withFileTypes:true})){
        if(item.name==='node_modules')continue;const target=join(path,item.name);
        if(item.isDirectory())await visit(target);else if(item.isFile()){
          const data=await readFile(target);files++;
          if(values.some(value=>data.includes(Buffer.from(value))))throw Error('Valor privado encontrado no frontend.');
        }
      }}await visit('/app/frontend');if(files<10)throw Error('Inspeção incompleta.');
      console.log(JSON.stringify({files,privateValuesFound:false}));
    `;
    const scanned = await command('docker', compose('exec', '-T', 'frontend', 'node', '--input-type=module', '-e', scan),
      { input: JSON.stringify(privateValues) });
    evidence.frontendScan = JSON.parse(scanned.stdout.trim());
  }
}

try {
  await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  ownsDirectory = true;
  const entries = ['backend', 'frontend', 'scripts', 'docker', 'tests', 'package.json', 'package-lock.json', '.npmrc', '.env.example', '.dockerignore', 'Dockerfile', 'compose.yaml'];
  for (const entry of entries) await cp(join(root, entry), join(directory, entry), {
    recursive: true, filter: path => !['node_modules', 'dist', '.local', '.git'].includes(basename(path)) &&
      !(basename(path).startsWith('.env') && basename(path) !== '.env.example') && path !== join(root, 'frontend', 'public', 'emulator'),
  });
  await command(join(dirname(process.execPath), 'npm'), ['ci']);
  evidence.checks.push('npm ci real em cópia nova, usando o lockfile');
  await command(process.execPath, ['scripts/setup.mjs']);
  for (const file of ['postgres_password', 'app_db_password']) privateValues.push((await readFile(join(directory, '.local', 'secrets', file), 'utf8')).trim());
  reservedPort = createServer();
  await new Promise((resolve, reject) => { reservedPort.once('error', reject); reservedPort.listen(0, '127.0.0.1', resolve); });
  const port = reservedPort.address().port;
  assert.notEqual(port, 5173);
  origin = `http://127.0.0.1:${port}`;
  await writeConfig(configuredFirst ? original : undefined);
  const beforeSetup = createHash('sha256').update(await readFile(envPath)).digest('hex');
  await command(process.execPath, ['scripts/setup.mjs']);
  assert.equal(createHash('sha256').update(await readFile(envPath)).digest('hex'), beforeSetup, 'Setup deve preservar a configuração existente.');
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  evidence.checks.push('setup real idempotente; .env 0600; senha com $ literal');
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  assert.equal((await command('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).stdout.trim(), '');
  for (const volume of volumes) assert.notEqual((await command('docker', ['volume', 'inspect', volume], { allowFailure: true })).code, 0, 'Volume efêmero deve ser novo.');
  await inspectConfidentiality();
  await new Promise((resolve, reject) => reservedPort.close(error => error ? reject(error) : resolve()));
  reservedPort = undefined;
  started = true;
  if (!configuredFirst) {
    const unconfigured = await command('docker', compose('up', '-d', '--no-build', '--pull', 'never', 'frontend'), { allowFailure: true });
    assert.notEqual(unconfigured.code, 0, 'Primeiro boot sem credenciais deve bloquear dependências.');
    const emptyDatabase = await snapshot();
    assert.equal(emptyDatabase.users, 0);
    assert.equal(emptyDatabase.masters, 0);
    const bootstrapId = (await command('docker', compose('ps', '-a', '-q', 'bootstrap'))).stdout.trim();
    assert.ok(bootstrapId);
    const bootstrapState = JSON.parse((await command('docker', ['inspect', bootstrapId])).stdout)[0].State;
    assert.notEqual(bootstrapState.ExitCode, 0);
    const backendId = (await command('docker', compose('ps', '-a', '-q', 'backend'))).stdout.trim();
    if (backendId) assert.equal(JSON.parse((await command('docker', ['inspect', backendId])).stdout)[0].State.Running, false);
    evidence.checks.push('banco novo sem ADMIN bloqueia bootstrap/backend e mantém zero contas');
    await writeConfig(original);
    const configuredHash = createHash('sha256').update(await readFile(envPath)).digest('hex');
    await command(process.execPath, ['scripts/setup.mjs']);
    assert.equal(createHash('sha256').update(await readFile(envPath)).digest('hex'), configuredHash, 'Setup deve preservar credenciais já escolhidas.');
    // An editor's atomic replacement invalidates the old secret bind inode on
    // Docker Desktop/WSL. Recreate only this stopped one-shot service after the
    // intentionally failed first attempt, then follow normal dependency order.
    await command('docker', compose('up', '-d', '--no-deps', '--force-recreate', '--no-build', '--pull', 'never', 'bootstrap'));
    evidence.checks.push('configuração substituída atomicamente; bootstrap recriado após tentativa inicial inválida');
  }
  await command('docker', compose('up', '-d', '--no-build', '--pull', 'never', 'frontend'));
  await waitFor('Instalação isolada', async () => (await request('/api/health')).status === 200);
  const session = await login(original);
  const initial = await snapshot();
  assert.equal(initial.users, 1);
  assert.equal(initial.masters, 1);
  assert.equal(initial.migrations, 4);
  assert.equal((await request('/api/users', { cookie: session.cookie })).status, 200);
  if (configuredFirst) evidence.checks.push('banco limpo configurado antes do primeiro up; bootstrap automático sem recriação');
  evidence.checks.push('primeiro boot automático cria exatamente um MASTER; login e administração reais');
  await inspectConfidentiality();
  evidence.checks.push('config, logs, inspect, ambiente, build e arquivos frontend sem credenciais');
  await command('docker', compose('restart', 'database'));
  await waitFor('PostgreSQL isolado', async () => { await sql('SELECT 1'); return true; });
  await command('docker', compose('restart', 'backend'));
  await waitFor('API reiniciada', async () => (await request('/api/health')).status === 200);
  assert.equal((await request('/api/auth/me', { cookie: session.cookie })).status, 200);
  assert.deepEqual(await snapshot(), initial);
  evidence.checks.push('reinício real do banco/backend preserva identidade, hash e sessão');
  await writeConfig(replacement);
  const changed = await command('docker', compose('run', '--rm', '--no-deps', '-T', 'bootstrap'));
  noPrivateValues(changed.stdout + changed.stderr, 'Novo bootstrap');
  assert.deepEqual(await snapshot(), initial);
  assert.equal((await login(original)).userId, session.userId);
  assert.equal((await request('/api/auth/login', { account: replacement })).status, 401);
  assert.equal((await request('/api/auth/login', { account: { username: original.username, password: replacement.password } })).status, 401);
  await writeConfig();
  const empty = await command('docker', compose('run', '--rm', '--no-deps', '-T', 'bootstrap'));
  noPrivateValues(empty.stdout + empty.stderr, 'Bootstrap sem credenciais');
  assert.deepEqual(await snapshot(), initial);
  assert.equal((await request('/api/auth/me', { cookie: session.cookie })).status, 200);
  evidence.checks.push('master existente ignora credenciais alteradas/ausentes, sem reset ou conta adicional');
  // Remove the private .env completely, retaining only nonsecret interpolation
  // settings in a separate test-owned file so port/volume isolation cannot change.
  interpolationFile = join(directory, 'firstboot-public.env');
  await writeFile(interpolationFile, [
    `APP_ORIGIN=${origin}`, `WEB_PORT=${new URL(origin).port}`, 'APP_DB_NAME=emulador',
    'SESSION_TTL_HOURS=168', `CATALOG_VOLUME=${catalogVolume}`, '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  await rm(envPath);
  await command('docker', compose('up', '-d', '--no-build', '--pull', 'never', 'frontend'));
  await waitFor('Instalação sem .env privada', async () => (await request('/api/health')).status === 200);
  assert.deepEqual(await snapshot(), initial);
  assert.equal((await request('/api/auth/me', { cookie: session.cookie })).status, 200);
  evidence.checks.push('ausência total da .env usa exemplo vazio sem redefinir master nem trocar volumes');
  await inspectConfidentiality();
  evidence.passed = true;
} catch (error) {
  failure = sanitize(error.message);
  evidence.error = failure;
} finally {
  if (reservedPort) await new Promise(resolve => reservedPort.close(resolve));
  const cleanupErrors = [];
  if (started) {
    try { await command('docker', compose('down', '--remove-orphans')); }
    catch (error) { cleanupErrors.push(sanitize(error.message)); }
    for (const volume of volumes) {
      try {
        const found = await command('docker', ['volume', 'inspect', volume], { allowFailure: true });
        if (found.code !== 0) continue;
        assert.equal(JSON.parse(found.stdout)[0].Labels['com.docker.compose.project'], project, 'Não remover volume de outro projeto.');
        await command('docker', ['volume', 'rm', volume]);
      } catch (error) { cleanupErrors.push(sanitize(error.message)); }
    }
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.cleaned = cleanupErrors.length === 0;
  if (cleanupErrors.length) { evidence.cleanupErrors = cleanupErrors; evidence.passed = false; failure ??= cleanupErrors.join('; '); }
  if (ownsDirectory) {
    await rm(envPath, { force: true });
    await rm(join(directory, '.local', 'secrets'), { recursive: true, force: true });
    await rm(join(directory, 'node_modules'), { recursive: true, force: true });
    await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  }
}
if (failure) { console.error(`Primeiro boot isolado reprovado: ${failure}`); process.exitCode = 1; }
else console.log(`Primeiro boot isolado validado; recursos próprios removidos. Evidência sem segredos: ${join(directory, 'evidence.json')}`);
