import { test, expect } from '@playwright/test';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import argon2 from 'argon2';
import pg from 'pg';
import { databaseConfig } from '../../backend/dist/config.js';
import { migrate } from '../../backend/dist/database/migrations.js';
import { playableGbRom, playableGbaRom, playableGbaFlashRom, PLAY_ROM_SAVE_MAGIC } from '../helpers/play-roms.mjs';

// Real mGBA WASM + HTTP API + an owned ephemeral PostgreSQL database. The
// cartridges execute original test programs and never use a commercial ROM.
const suffix = randomBytes(8).toString('hex');
const database = `emulador_browser_${suffix}`;
const password = randomBytes(24).toString('base64url');
const adminPool = new pg.Pool(databaseConfig());
const originalEnvironment = Object.fromEntries(['PGDATABASE', 'APP_ORIGIN', 'CATALOG_STORAGE_DIR'].map((key) => [key, process.env[key]]));
const games = {};
let ownsDatabase = false;
let directory;
let origin;
let app;
let vite;
let pool;
let passwordHash;
let masterSession;

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function createUser(role = 'JOGADOR') {
  const user = { id: randomUUID(), username: `play_${randomBytes(8).toString('hex')}` };
  await pool.query('INSERT INTO users (id, username, password_hash, role) VALUES ($1,$2,$3,$4)', [user.id, user.username, passwordHash, role]);
  return user;
}

test.beforeAll(async () => {
  await adminPool.query(`CREATE DATABASE "${database}"`);
  ownsDatabase = true;
  directory = await mkdtemp(join(tmpdir(), 'emulador-player-browser-'));
  process.env.PGDATABASE = database;
  process.env.CATALOG_STORAGE_DIR = join(directory, 'catalog');
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  process.env.APP_ORIGIN = origin;
  pool = new pg.Pool(databaseConfig());
  await migrate(pool);
  passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  const master = await createUser('MASTER');
  const { createApp } = await import('../../backend/dist/app.js');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  vite = await createViteServer({
    configFile: false, root: 'frontend', plugins: [react()], cacheDir: join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': { target: await app.getUrl(), changeOrigin: false } } },
    logLevel: 'silent',
  });
  await vite.listen();
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { Origin: origin, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: master.username, password }),
  });
  expect(response.status).toBe(200);
  const session = await response.json();
  const cookie = response.headers.get('set-cookie').split(';', 1)[0];
  masterSession = { cookie, csrfToken: session.csrfToken };
  for (const [key, console, bytes] of [['GB', 'GB', playableGbRom()], ['GBA', 'GBA', playableGbaRom()], ['FLASH1M', 'GBA', playableGbaFlashRom()]]) {
    const body = new FormData();
    body.set('name', `Programa próprio ${key}`);
    body.set('active', 'true');
    body.set('rom', new Blob([bytes]), `own-sram.${console.toLowerCase()}`);
    const created = await fetch(`${origin}/api/games`, {
      method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': session.csrfToken }, body,
    });
    expect(created.status).toBe(201);
    games[key] = (await created.json()).game;
  }
  await mkdir('.local/screenshots', { recursive: true, mode: 0o700 });
});

test.afterAll(async () => {
  try {
    try {
      try { await vite?.close(); } finally { await app?.close(); }
    } finally {
      try { await pool?.end(); }
      finally { if (ownsDatabase) await adminPool.query(`DROP DATABASE "${database}" WITH (FORCE)`); }
    }
  } finally {
    await adminPool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

async function login(page, user) {
  await page.goto(origin);
  await page.getByLabel('Nome de usuário', { exact: true }).fill(user.username);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
}

async function openGame(page, gameConsole) {
  await page.getByRole('article', { name: games[gameConsole].name, exact: true }).getByRole('button', { name: 'Jogar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Iniciar jogo', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar jogo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toBeVisible();
}

async function screenPixel(page) {
  return page.getByLabel('Tela do jogo', { exact: true }).evaluate((canvas) => {
    const pixel = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return Array.from(pixel).slice(0, 3);
  });
}

function screenMatches(gameConsole, value, rgb) {
  if (gameConsole === 'GBA') return value === 1 ? rgb[1] > 180 && rgb[0] < 80 : rgb[0] > 180 && rgb[1] < 80;
  return value === 1 ? Math.max(...rgb) < 100 : Math.min(...rgb) > 150;
}

async function expectScreen(page, gameConsole, value) {
  await expect.poll(async () => screenMatches(gameConsole, value, await screenPixel(page)), { message: `${gameConsole} must render saved value ${value}` }).toBe(true);
}

async function pressKey(page, key) {
  await page.getByLabel('Tela do jogo', { exact: true }).focus();
  await page.keyboard.down(key);
  await page.waitForTimeout(120); // Multiple emulated frames with the physical key held.
  await page.keyboard.up(key);
}

async function saved(user, gameConsole) {
  return (await pool.query('SELECT data, sha256, version FROM game_saves WHERE user_id=$1 AND game_id=$2', [user.id, games[gameConsole].id])).rows[0];
}

async function expectSaved(user, gameConsole, value) {
  await expect.poll(async () => {
    const record = await saved(user, gameConsole);
    return record ? [record.data[0], record.data[1]] : null;
  }).toEqual([value, PLAY_ROM_SAVE_MAGIC]);
  const record = await saved(user, gameConsole);
  expect(record.sha256).toBe(createHash('sha256').update(record.data).digest('hex'));
  expect(record.version).toBeGreaterThan(0);
  expect(record.data.length).toBeGreaterThan(2);
  return record;
}

async function leaveGame(page) {
  await page.getByRole('button', { name: 'Salvar e voltar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
}

async function recoverySummary(page, user, gameConsole) {
  return page.evaluate(async ({ userId, gameId }) => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('emulador-save-recovery-v1', 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      if (!db.objectStoreNames.contains('pending')) return null;
      const value = await new Promise((resolve, reject) => {
        const request = db.transaction('pending', 'readonly').objectStore('pending').get(`${userId}:${gameId}`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const prefix = (data) => Array.from(atob(data).slice(0, 2), (char) => char.charCodeAt(0));
      return value ? { revision: value.revision, sha256: value.sha256, userId: value.userId, gameId: value.gameId, baseVersion: value.baseVersion,
        firstBytes: prefix(value.dataBase64), nextFirstBytes: value.next ? prefix(value.next.dataBase64) : null } : null;
    } finally { db.close(); }
  }, { userId: user.id, gameId: games[gameConsole].id });
}

for (const gameConsole of ['GB', 'GBA']) {
  test(`${gameConsole}: motor real, pausa, áudio, teclado e save nativo entre sessões e usuários`, async ({ page, browser }) => {
    const user = await createUser();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await login(page, user);
    await openGame(page, gameConsole);
    await expectScreen(page, gameConsole, 0);
    await page.getByRole('button', { name: 'Pausar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retomar', exact: true })).toBeVisible();
    await pressKey(page, 'x');
    await expectScreen(page, gameConsole, 0);
    await page.getByRole('button', { name: 'Retomar', exact: true }).click();
    await page.getByRole('button', { name: 'Ativar áudio', exact: true }).click();
    await page.getByRole('button', { name: 'Silenciar', exact: true }).click();
    await pressKey(page, 'x');
    await expectScreen(page, gameConsole, 1);
    await expectSaved(user, gameConsole, 1);
    await expect(page.getByTestId('save-status')).toContainText(/salvo|sincronizado/i);
    await page.getByRole('button', { name: 'Tela cheia', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await page.evaluate(() => document.exitFullscreen());
    await page.screenshot({ path: `.local/screenshots/player-${gameConsole.toLowerCase()}-saved-desktop.png`, fullPage: true });
    await leaveGame(page);
    expect(Number((await pool.query('SELECT count(*) FROM play_leases WHERE user_id=$1 AND game_id=$2', [user.id, games[gameConsole].id])).rows[0].count)).toBe(0);

    // A fresh browser context has no local recovery state: this proves the
    // native save is restored from the authenticated PostgreSQL record.
    const context = await browser.newContext();
    try {
      const resumed = await context.newPage();
      await login(resumed, user);
      await openGame(resumed, gameConsole);
      await expectScreen(resumed, gameConsole, 1);
      await pressKey(resumed, 'z');
      await expectScreen(resumed, gameConsole, 0);
      await expectSaved(user, gameConsole, 0);
      await leaveGame(resumed);
    } finally { await context.close(); }
    const other = await createUser();
    const otherContext = await browser.newContext();
    try {
      const isolated = await otherContext.newPage();
      await login(isolated, other);
      await openGame(isolated, gameConsole);
      await expectScreen(isolated, gameConsole, 0);
      await pressKey(isolated, 'x');
      await expectSaved(other, gameConsole, 1);
      expect((await saved(user, gameConsole)).data[0]).toBe(0);
      await leaveGame(isolated);
    } finally { await otherContext.close(); }
    expect(errors).toEqual([]);
  });
}

for (const [gameConsole, theme, width] of [['GB', 'light', 390], ['GBA', 'dark', 320]]) {
  test(`${gameConsole}: toque real e layout ${theme} em ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true, colorScheme: theme });
    try {
      const page = await context.newPage();
      const user = await createUser();
      await login(page, user);
      await openGame(page, gameConsole);
      await expectScreen(page, gameConsole, 0);
      const button = page.getByRole('button', { name: 'Botão A', exact: true });
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await page.waitForTimeout(150);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expectScreen(page, gameConsole, 1);
      await expectSaved(user, gameConsole, 1);
      for (const name of ['Direcional cima', 'Direcional baixo', 'Direcional esquerda', 'Direcional direita', 'Start', 'Select', 'Botão B']) {
        await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
      }
      if (gameConsole === 'GBA') {
        await expect(page.getByRole('button', { name: 'Botão L', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Botão R', exact: true })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `.local/screenshots/player-${gameConsole.toLowerCase()}-${theme}-${width}.png`, fullPage: true });
      await leaveGame(page);
    } finally { await context.close(); }
  });
}

test('GBA Flash1M restaura os 128KiB antes de executar e preserva a segunda bancada', async ({ page, browser }) => {
  const user = await createUser();
  await login(page, user);
  await openGame(page, 'FLASH1M');
  await expectScreen(page, 'GBA', 0);
  await pressKey(page, 'x');
  await expectScreen(page, 'GBA', 1);
  const initial = await expectSaved(user, 'FLASH1M', 1);
  expect(initial.data.length).toBe(131072);
  await leaveGame(page);

  // Own synthetic bytes in this run-owned database: sentinels beyond64KiB
  // detect truncation or restoration into the wrong kind of cartridge memory.
  const expected = Buffer.from(initial.data);
  expected[0x10000] = 0xa5;
  expected[0x1ffff] = 0x5a;
  await pool.query('UPDATE game_saves SET data=$1,sha256=$2,version=version+1 WHERE user_id=$3 AND game_id=$4',
    [expected, createHash('sha256').update(expected).digest('hex'), user.id, games.FLASH1M.id]);
  const fresh = await browser.newContext();
  try {
    const resumed = await fresh.newPage();
    await login(resumed, user);
    await openGame(resumed, 'FLASH1M');
    await expectScreen(resumed, 'GBA', 1);
    await pressKey(resumed, 'z');
    await expectScreen(resumed, 'GBA', 0);
    const final = await expectSaved(user, 'FLASH1M', 0);
    expect(final.data.length).toBe(131072);
    expect([final.data[0x10000], final.data[0x1ffff]]).toEqual([0xa5, 0x5a]);
    await resumed.screenshot({ path: '.local/screenshots/player-gba-flash128-restored.png', fullPage: true });
    await leaveGame(resumed);
  } finally { await fresh.close(); }
});

test('keyup com foco em botão libera a tecla e recusas de áudio/tela cheia são avisos dispensáveis', async ({ page }) => {
  const user = await createUser();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, user);
  await openGame(page, 'GBA');
  await expectScreen(page, 'GBA', 0);
  await page.getByLabel('Tela do jogo', { exact: true }).focus();
  await page.keyboard.down('x');
  await expectScreen(page, 'GBA', 1);
  await page.getByRole('button', { name: 'Pausar', exact: true }).focus();
  await page.keyboard.up('x');
  // A has priority over B in this cartridge: B cannot turn the screen red if
  // keyup was incorrectly ignored after focus moved from canvas to a button.
  await pressKey(page, 'z');
  await expectScreen(page, 'GBA', 0);

  await page.evaluate(() => {
    AudioContext.prototype.resume = () => Promise.reject(new DOMException('Synthetic browser refusal', 'NotAllowedError'));
    Element.prototype.requestFullscreen = () => Promise.reject(new DOMException('Synthetic browser refusal', 'NotAllowedError'));
  });
  for (const [control, message] of [
    ['Ativar áudio', 'O navegador não ativou o áudio. Tente novamente pelo botão de áudio.'],
    ['Tela cheia', 'Tela cheia não está disponível neste navegador.'],
  ]) {
    await page.getByRole('button', { name: control, exact: true }).click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Pausar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retomar', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Retomar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Dispensar aviso', exact: true }).click();
    await expect(page.getByText(message, { exact: true })).toHaveCount(0);
  }
  await leaveGame(page);
  expect(errors).toEqual([]);
});

test('renova a lease durante carga lenta da ROM e encerra os timers ao sair', async ({ page }) => {
  const user = await createUser();
  await login(page, user);
  await page.getByRole('article', { name: games.GBA.name, exact: true }).getByRole('button', { name: 'Jogar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Iniciar jogo', exact: true })).toBeVisible();
  await page.clock.install();
  let notifyLoading;
  let releaseRom;
  const loading = new Promise((resolve) => { notifyLoading = resolve; });
  const released = new Promise((resolve) => { releaseRom = resolve; });
  const writes = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/play/${games.GBA.id}/lease/renew`) || request.url().endsWith(`/api/play/${games.GBA.id}/save`)) {
      writes.push(request.url());
    }
  });
  const url = `**/api/play/${games.GBA.id}/rom`;
  await page.route(url, async (route) => { notifyLoading(); await released; await route.continue(); });
  try {
    await page.getByRole('button', { name: 'Iniciar jogo', exact: true }).click();
    await loading;
    const renewed = page.waitForResponse((response) => response.url().endsWith(`/api/play/${games.GBA.id}/lease/renew`) && response.status() === 200);
    await page.clock.fastForward(31_000);
    await renewed;
    await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toHaveCount(0);
    releaseRom();
    await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toBeVisible();
    await page.clock.runFor(300);
    await expectScreen(page, 'GBA', 0);
    await leaveGame(page);
    const countAfterExit = writes.length;
    expect(countAfterExit).toBeGreaterThanOrEqual(2);
    await page.clock.fastForward(90_000);
    await page.waitForTimeout(100);
    expect(writes.length).toBe(countAfterExit);
    expect(Number((await pool.query('SELECT count(*) FROM play_leases WHERE user_id=$1 AND game_id=$2', [user.id, games.GBA.id])).rows[0].count)).toBe(0);
  } finally {
    releaseRom();
    await page.unroute(url);
  }
});

test('pausar durante PUT lento aguarda A e sincroniza o snapshot B antes de permanecer pausado', async ({ page }) => {
  const user = await createUser();
  await login(page, user);
  await openGame(page, 'GBA');
  await expectScreen(page, 'GBA', 0);
  let notifyCommitted;
  let releaseResponse;
  let held = false;
  let confirmedVersion;
  const committed = new Promise((resolve) => { notifyCommitted = resolve; });
  const released = new Promise((resolve) => { releaseResponse = resolve; });
  const url = `**/api/play/${games.GBA.id}/save`;
  await page.route(url, async (route) => {
    const payload = route.request().postDataJSON();
    if (!held && Buffer.from(payload.dataBase64, 'base64')[0] === 1) {
      held = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      confirmedVersion = (await response.json()).save.version;
      notifyCommitted();
      await released;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await pressKey(page, 'x');
    await expectScreen(page, 'GBA', 1);
    await committed;
    await pressKey(page, 'z');
    await expectScreen(page, 'GBA', 0);
    await page.getByRole('button', { name: 'Pausar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retomar', exact: true })).toBeVisible();
    // Separate real DB writes by its one-second quota while keeping A's
    // acknowledgement held; this regression concerns the pending snapshot.
    await page.waitForTimeout(1100);
    releaseResponse();
    const record = await expectSaved(user, 'GBA', 0);
    expect(record.version).toBe(confirmedVersion + 1);
    await expect(page.getByTestId('save-status')).toContainText('Salvo no servidor');
    await expect(page.getByRole('button', { name: 'Retomar', exact: true })).toBeEnabled();
    await expect.poll(() => recoverySummary(page, user, 'GBA')).toBe(null);
    await leaveGame(page);
  } finally {
    releaseResponse();
    await page.unroute(url);
  }
});

test('duas abas do mesmo usuário não executam o mesmo jogo simultaneamente', async ({ page, context }) => {
  const user = await createUser();
  await login(page, user);
  await openGame(page, 'GB');
  const second = await context.newPage();
  try {
    await second.goto(origin);
    await expect(second.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
    const conflict = second.waitForResponse((response) => response.url().endsWith(`/api/play/${games.GB.id}/lease`) && response.status() === 409);
    await second.getByRole('article', { name: games.GB.name, exact: true }).getByRole('button', { name: 'Jogar', exact: true }).click();
    await second.getByRole('button', { name: 'Iniciar jogo', exact: true }).click();
    await conflict;
    await expect(second.getByRole('alert')).toBeVisible();
    await expect(second.getByRole('button', { name: 'Pausar', exact: true })).toHaveCount(0);
    expect(Number((await pool.query('SELECT count(*) FROM play_leases WHERE user_id=$1 AND game_id=$2', [user.id, games.GB.id])).rows[0].count)).toBe(1);
    await leaveGame(page);
  } finally { await second.close(); }
});

test('jogo desativado permite voltar à biblioteca quando o progresso já foi confirmado', async ({ page }) => {
  const user = await createUser();
  async function setActive(active) {
    const body = new FormData();
    body.set('active', String(active));
    const response = await fetch(`${origin}/api/games/${games.GBA.id}`, {
      method: 'PATCH', headers: { Origin: origin, Cookie: masterSession.cookie,
        'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': masterSession.csrfToken }, body,
    });
    expect(response.status).toBe(200);
  }
  await login(page, user);
  await openGame(page, 'GBA');
  await expectScreen(page, 'GBA', 0);
  await pressKey(page, 'x');
  const confirmed = await expectSaved(user, 'GBA', 1);
  await expect(page.getByTestId('save-status')).toContainText('Salvo no servidor');
  await expect.poll(() => recoverySummary(page, user, 'GBA')).toBe(null);
  try {
    await setActive(false);
    await leaveGame(page);
    await expect(page.getByRole('article', { name: games.GBA.name, exact: true })).toHaveCount(0);
    expect((await saved(user, 'GBA')).sha256).toBe(confirmed.sha256);
    expect((await saved(user, 'GBA')).version).toBe(confirmed.version);
  } finally { await setActive(true); }
});

test('falha ao salvar pausa o motor e recupera o progresso por retry e após recarregar', async ({ page }) => {
  const user = await createUser();
  await login(page, user);
  await openGame(page, 'GBA');
  await expectScreen(page, 'GBA', 0);
  const url = `**/api/play/${games.GBA.id}/save`;
  await page.route(url, (route) => route.abort('failed'));
  await pressKey(page, 'x');
  await expectScreen(page, 'GBA', 1);
  await expect(page.getByRole('button', { name: 'Tentar sincronizar', exact: true })).toBeVisible();
  await expect(page.getByTestId('save-status')).toContainText(/local|pendente|falh|sincroniz/i);
  await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toHaveCount(0);
  expect(await recoverySummary(page, user, 'GBA')).toMatchObject({ userId: user.id, gameId: games.GBA.id, firstBytes: [1, PLAY_ROM_SAVE_MAGIC] });
  await page.unroute(url);
  await page.getByRole('button', { name: 'Tentar sincronizar', exact: true }).click();
  await expectSaved(user, 'GBA', 1);
  await expect(page.getByTestId('save-status')).toContainText(/salvo|sincronizado/i);

  await page.route(url, (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'Retomar', exact: true }).click();
  // Retomar renews the lease asynchronously; input must wait for the running
  // state, otherwise a key can be correctly ignored while it is still paused.
  await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toBeVisible();
  await page.getByLabel('Tela do jogo', { exact: true }).focus();
  await page.keyboard.down('z');
  try { await expectScreen(page, 'GBA', 0); }
  finally { await page.keyboard.up('z'); }
  await expect(page.getByRole('button', { name: 'Voltar mantendo cópia local', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Voltar mantendo cópia local', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
  expect((await saved(user, 'GBA')).data[0]).toBe(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
  await page.unroute(url);
  await openGame(page, 'GBA');
  await expectScreen(page, 'GBA', 0);
  await expectSaved(user, 'GBA', 0);
  await leaveGame(page);
});

test('save corrompido na resposta da lease preserva a cópia local íntegra e impede execução', async ({ page }) => {
  const user = await createUser();
  await login(page, user);
  await openGame(page, 'GBA');
  await expectScreen(page, 'GBA', 0);
  await pressKey(page, 'x');
  const record = await expectSaved(user, 'GBA', 1);
  await leaveGame(page);
  const pending = { revision: randomUUID(), userId: user.id, gameId: games.GBA.id, baseVersion: record.version - 1,
    dataBase64: record.data.toString('base64'), sha256: record.sha256, savedAt: new Date().toISOString() };
  await page.evaluate(async (entry) => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('emulador-save-recovery-v1', 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('pending', 'readwrite');
        tx.objectStore('pending').put(entry, `${entry.userId}:${entry.gameId}`);
        tx.oncomplete = resolve;
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, pending);
  const expectedRecovery = await recoverySummary(page, user, 'GBA');
  const url = `**/api/play/${games.GBA.id}/lease`;
  await page.route(url, async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    const body = await response.json();
    const corrupt = Buffer.from(body.save.dataBase64, 'base64');
    corrupt[0] ^= 1;
    body.save.dataBase64 = corrupt.toString('base64'); // Leave the original hash.
    await route.fulfill({ response, json: body });
  });
  try {
    await page.getByRole('article', { name: games.GBA.name, exact: true }).getByRole('button', { name: 'Jogar', exact: true }).click();
    await page.getByRole('button', { name: 'Iniciar jogo', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(/integridade.*cópia local.*preservada/i);
    await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toHaveCount(0);
    expect(await recoverySummary(page, user, 'GBA')).toEqual(expectedRecovery);
    expect((await saved(user, 'GBA')).sha256).toBe(record.sha256);
    await expect.poll(async () => Number((await pool.query('SELECT count(*) FROM play_leases WHERE user_id=$1 AND game_id=$2', [user.id, games.GBA.id])).rows[0].count)).toBe(0);
    await page.getByRole('button', { name: 'Voltar à biblioteca', exact: true }).click();
  } finally { await page.unroute(url); }
  await openGame(page, 'GBA');
  await expectScreen(page, 'GBA', 1);
  await expect.poll(() => recoverySummary(page, user, 'GBA')).toBe(null);
  expect((await saved(user, 'GBA')).version).toBe(record.version);
  await leaveGame(page);
});

for (const method of ['retry', 'reabrir']) {
test(`resposta perdida de save A preserva sucessor B até confirmar por ${method}`, async ({ page }) => {
  const user = await createUser();
  await login(page, user);
  await openGame(page, 'GBA');
  await expectScreen(page, 'GBA', 0);
  let notifyCommitted;
  let releaseResponse;
  let blockRequests = true;
  let held = false;
  let confirmedVersion;
  const committed = new Promise((resolve) => { notifyCommitted = resolve; });
  const released = new Promise((resolve) => { releaseResponse = resolve; });
  const statuses = [];
  page.on('response', (response) => {
    if (response.url().endsWith(`/api/play/${games.GBA.id}/save`)) statuses.push(response.status());
  });
  const url = `**/api/play/${games.GBA.id}/save`;
  await page.route(url, async (route) => {
    const payload = route.request().postDataJSON();
    if (!held && Buffer.from(payload.dataBase64, 'base64')[0] === 1) {
      held = true;
      // The transaction succeeds, but its HTTP acknowledgement is lost while
      // the real emulated cartridge advances to a newer native save.
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      confirmedVersion = (await response.json()).save.version;
      notifyCommitted();
      await released;
      await route.abort('failed');
    } else if (held && blockRequests) await route.abort('failed');
    else await route.continue();
  });
  try {
    await pressKey(page, 'x');
    await expectScreen(page, 'GBA', 1);
    await committed;
    expect((await saved(user, 'GBA')).data[0]).toBe(1);
    await pressKey(page, 'z');
    await expectScreen(page, 'GBA', 0);
    // The periodic capture queues B behind the deliberately unacknowledged A.
    await page.waitForTimeout(2200);
    releaseResponse();
    await expect(page.getByRole('button', { name: 'Tentar sincronizar', exact: true })).toBeVisible();
    await expect.poll(async () => (await recoverySummary(page, user, 'GBA'))?.nextFirstBytes).toEqual([0, PLAY_ROM_SAVE_MAGIC]);
    expect((await recoverySummary(page, user, 'GBA')).firstBytes).toEqual([1, PLAY_ROM_SAVE_MAGIC]);
    if (method === 'retry') {
      blockRequests = false;
      await page.getByRole('button', { name: 'Tentar sincronizar', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Voltar mantendo cópia local', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
      expect((await saved(user, 'GBA')).data[0]).toBe(1);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
      blockRequests = false;
      await openGame(page, 'GBA');
      await expectScreen(page, 'GBA', 0);
    }
    const record = await expectSaved(user, 'GBA', 0);
    expect(record.version).toBe(confirmedVersion + 1);
    await expect.poll(() => recoverySummary(page, user, 'GBA')).toBe(null);
    expect(statuses).not.toContain(409);
    await expect(page.getByTestId('save-status')).toContainText('Salvo no servidor');
    await leaveGame(page);
  } finally {
    releaseResponse();
    await page.unroute(url);
  }
});
}
