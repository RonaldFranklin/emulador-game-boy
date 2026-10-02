import { completeFixtureMaster } from '../helpers/browser-master.mjs';
import { test, expect } from '@playwright/test';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { databaseConfig } from '../../backend/dist/config.js';
import { migrate } from '../../backend/dist/database/migrations.js';

// Run within the project's Playwright container. Browsers, Nest and Vite share
// its loopback interface; only this randomly named test database is modified.
const suffix = randomBytes(8).toString('hex');
const database = `emulador_browser_${suffix}`;
const master = `master_${suffix}`;
const player = `player_${suffix}`;
const password = randomBytes(24).toString('base64url');
const temporary = randomBytes(24).toString('base64url');
const personal = randomBytes(24).toString('base64url');
const resetTemporary = randomBytes(24).toString('base64url');
const resetPersonal = randomBytes(24).toString('base64url');
const originalEnvironment = {
  TRUSTED_PROXY_HOST: process.env.TRUSTED_PROXY_HOST,
  PGDATABASE: process.env.PGDATABASE,
  APP_ORIGIN: process.env.APP_ORIGIN,
  API_PROXY_TARGET: process.env.API_PROXY_TARGET,
  CATALOG_STORAGE_DIR: process.env.CATALOG_STORAGE_DIR,
};
const adminPool = new pg.Pool(databaseConfig());
let origin, vite, app, createApp;
let backendPort = 0;
let createdDatabase = false;
let storageDirectory;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startApp() {
  app = await createApp();
  await app.listen(backendPort, '127.0.0.1');
  backendPort = app.getHttpServer().address().port;
}

async function health() {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Backend de teste não ficou pronto.');
}

async function bootstrap() {
  await new Promise((resolve, reject) => {
    const child = spawn('python3', ['tests/bootstrap-cli.py', database], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BOOTSTRAP_LOCAL: '1' },
    });
    let stderr = '', stdout = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Bootstrap TTY falhou: ${stderr || stdout}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        expect(result).toMatchObject({ ok: true, username: master, passwordEchoed: false });
        resolve();
      } catch (error) { reject(error); }
    });
    // Neither process arguments, environment nor files receive the password.
    child.stdin.end(JSON.stringify({ username: master, password }));
  });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await adminPool.query(`CREATE DATABASE ${database}`);
  createdDatabase = true;
  const migrationPool = new pg.Pool({ ...databaseConfig(), database });
  try { await migrate(migrationPool); } finally { await migrationPool.end(); }
  process.env.PGDATABASE = database;
  process.env.TRUSTED_PROXY_HOST = 'localhost';
  storageDirectory = await mkdtemp(join(tmpdir(), 'emulador-application-catalog-'));
  process.env.CATALOG_STORAGE_DIR = storageDirectory;
  await bootstrap();

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  process.env.APP_ORIGIN = origin;
  ({ createApp } = await import('../../backend/dist/app.js'));
  await startApp();
  process.env.API_PROXY_TARGET = `http://127.0.0.1:${backendPort}`;
  vite = await createViteServer({
    configFile: 'frontend/vite.config.ts',
    root: 'frontend',
    server: { host: '127.0.0.1', port, strictPort: true },
    logLevel: 'silent',
  });
  await vite.listen();
  await health();
  await mkdir('.local/screenshots', { recursive: true, mode: 0o700 });
});

test.afterAll(async () => {
  try {
    try { await vite?.close(); } finally { await app?.close(); }
  } finally {
    try {
      if (createdDatabase) await adminPool.query(`DROP DATABASE ${database} WITH (FORCE)`);
    } finally {
      await adminPool.end();
      if (storageDirectory) await rm(storageDirectory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});

async function login(page, username, secret) {
  await page.goto(origin);
  await page.getByLabel('Nome de usuário', { exact: true }).fill(username);
  await page.getByLabel('Senha', { exact: true }).fill(secret);
  const result=page.waitForResponse(r=>r.url().endsWith('/api/auth/login')&&r.request().method()==='POST');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await completeFixtureMaster(page,await result);
}

async function changeTemporaryPassword(page, current, next) {
  await expect(page.getByRole('heading', { name: 'Defina sua senha' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Jogar', exact: true })).toHaveCount(0);
  await page.getByLabel('Senha temporária atual').fill(current);
  await page.getByLabel('Nova senha', { exact: true }).fill(next);
  await page.getByLabel('Confirme a senha', { exact: true }).fill(next);
  await page.getByRole('button', { name: 'Salvar nova senha', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entre na sua conta' })).toBeVisible();
}

test('desktop e celular: bootstrap sem eco, administração, revogação e sessão após reiniciar aplicação', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Entre na sua conta' })).toBeVisible();
  await page.screenshot({ path: '.local/screenshots/login-desktop.png', fullPage: true });
  await login(page, master, password);
  await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
  await expect(page.getByText('0 jogos disponíveis')).toBeVisible();
  expect(await page.evaluate(() => document.cookie)).not.toContain('emulador_session');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.getByRole('button', { name: 'Administração', exact: true }).click();
  await page.getByLabel('Nome de usuário', { exact: true }).fill(player);
  await page.getByLabel('Senha temporária', { exact: true }).fill(temporary);
  await page.getByLabel('Confirme a senha', { exact: true }).fill(temporary);
  await page.getByRole('button', { name: 'Criar jogador', exact: true }).click();
  await expect(page.getByText(player, { exact: true })).toBeVisible();
  await page.screenshot({ path: '.local/screenshots/administracao-desktop.png', fullPage: true });

  // Keep the browser cookie, close Nest (including its pool), and start a fresh
  // app on the same port. A separate operational test restarts PostgreSQL.
  await app.close();
  app = undefined;
  await startApp();
  await health();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Administração', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Administração', exact: true }).click();
  await expect(page.getByText(player, { exact: true })).toBeVisible();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const mobile = await mobileContext.newPage();
    mobile.on('pageerror', error => errors.push(error.message));
    await mobile.goto(origin);
    await expect(mobile.getByRole('heading', { name: 'Entre na sua conta' })).toBeVisible();
    await mobile.screenshot({ path: '.local/screenshots/login-mobile.png', fullPage: true });
    await login(mobile, player, temporary);
    await changeTemporaryPassword(mobile, temporary, personal);
    await login(mobile, player, personal);
    await expect(mobile.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
    await expect(mobile.getByRole('button', { name: 'Administração', exact: true })).toHaveCount(0);
    expect(await mobile.evaluate(async () => (await fetch('/api/users')).status)).toBe(403);
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mobile.screenshot({ path: '.local/screenshots/biblioteca-mobile.png', fullPage: true });

    await page.getByRole('button', { name: `Redefinir senha de ${player}`, exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Nova senha temporária', { exact: true }).fill(resetTemporary);
    await dialog.getByLabel('Confirme a senha', { exact: true }).fill(resetTemporary);
    await dialog.getByRole('button', { name: 'Confirmar redefinição', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await mobile.reload();
    await expect(mobile.getByRole('heading', { name: 'Entre na sua conta' })).toBeVisible();
    await login(mobile, player, personal);
    await expect(mobile.getByRole('alert')).toContainText('Usuário ou senha inválidos.');
    await login(mobile, player, resetTemporary);
    await changeTemporaryPassword(mobile, resetTemporary, resetPersonal);
    await login(mobile, player, resetPersonal);
    await expect(mobile.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();

    await page.getByRole('button', { name: `Bloquear ${player}`, exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Confirmar bloqueio', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await mobile.reload();
    await expect(mobile.getByRole('heading', { name: 'Entre na sua conta' })).toBeVisible();
    await login(mobile, player, resetPersonal);
    await expect(mobile.getByRole('alert')).toContainText('Usuário ou senha inválidos.');
    await page.getByRole('button', { name: `Desbloquear ${player}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `Bloquear ${player}`, exact: true })).toBeVisible();
    await login(mobile, player, resetPersonal);
    await expect(mobile.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
    await mobile.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(mobile.getByRole('heading', { name: 'Entre na sua conta' })).toBeVisible();
    expect(await mobile.evaluate(async () => (await fetch('/api/games')).status)).toBe(401);
  } finally {
    await mobileContext.close();
  }
  expect(errors).toEqual([]);
});


test('login 429 aparece na UI; Vite sanitiza spoofing e distingue sockets clientes', async ({ page, browser }) => {
  const pool = new pg.Pool(databaseConfig());
  const anonymous = await browser.newContext();
  try {
    await pool.query('DELETE FROM login_attempts'); // Only this suite's random DB.
    await page.goto(origin);
    await login(page, master, password);
    await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
    const blockedPage = await anonymous.newPage();
    await blockedPage.goto(origin);
    for (let i = 0; i < 3; i++) {
      await anonymous.setExtraHTTPHeaders({ 'X-Forwarded-For': `203.0.113.${i+1}`, Forwarded: 'for=192.0.2.1', 'X-Real-IP': '198.51.100.1' });
      const pending = blockedPage.waitForResponse(r => r.url().endsWith('/api/auth/login'));
      await login(blockedPage, `missing_${i}`, 'incorrect_password');
      const result = await pending;
      expect(result.status()).toBe(i === 2 ? 429 : 401);
      if (i === 2) expect(result.headers()['retry-after']).toBe('7200');
    }
    await expect(blockedPage.getByRole('alert')).toContainText('Login temporariamente bloqueado para este IP');
    expect(await page.evaluate(async () => (await fetch('/api/auth/me')).status)).toBe(200);
    const different = await new Promise((resolve, reject) => {
      const req = httpRequest(`${origin}/api/auth/login`, { method: 'POST', localAddress: '127.0.0.2', headers: {
        Origin: origin, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json',
        'X-Forwarded-For': '127.0.0.1', Forwarded: 'for=127.0.0.1',
      } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(JSON.stringify({ username: master, password }));
    });
    expect(different).toBe(200);
    const hash = text => createHash('sha256').update(text).digest('hex');
    const rows = await pool.query('SELECT key,cardinality(failure_times) AS failures FROM login_attempts WHERE key=ANY($1)',
      [[hash('login-failures:127.0.0.1'), hash('login-failures:127.0.0.2')]]);
    expect(rows.rows).toEqual(expect.arrayContaining([
      { key: hash('login-failures:127.0.0.1'), failures: 3 },
      { key: hash('login-failures:127.0.0.2'), failures: 0 },
    ]));
  } finally { await anonymous.close(); await pool.end(); }
});
