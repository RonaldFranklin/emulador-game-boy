import { test, expect } from '@playwright/test';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import argon2 from 'argon2';
import pg from 'pg';
import { databaseConfig } from '../../backend/dist/config.js';
import { migrate } from '../../backend/dist/database/migrations.js';
import { syntheticCover, syntheticGbaRom, syntheticRom } from '../helpers/catalog-fixtures.mjs';

// Real API + private PostgreSQL database + private files, all discarded after
// this suite. All cartridge/image bytes are synthetic and generated in memory.
const suffix = randomBytes(8).toString('hex');
const database = `emulador_browser_${suffix}`;
const masterUsername = `master_${suffix}`;
const playerUsername = `player_${suffix}`;
const secret = randomBytes(24).toString('base64url');
const adminPool = new pg.Pool(databaseConfig());
const originalEnvironment = Object.fromEntries(['PGDATABASE', 'APP_ORIGIN', 'CATALOG_STORAGE_DIR'].map((key) => [key, process.env[key]]));
let ownsDatabase = false;
let temporaryDirectory;
let origin;
let app;
let vite;

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

test.beforeAll(async () => {
  await adminPool.query(`CREATE DATABASE "${database}"`);
  ownsDatabase = true;
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'emulador-catalog-browser-'));
  process.env.PGDATABASE = database;
  process.env.CATALOG_STORAGE_DIR = join(temporaryDirectory, 'catalog');
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  process.env.APP_ORIGIN = origin;
  const pool = new pg.Pool(databaseConfig());
  try {
    await migrate(pool);
    const hash = await argon2.hash(secret, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    for (const [username, role] of [[masterUsername, 'MASTER'], [playerUsername, 'JOGADOR']]) {
      await pool.query('INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)', [randomUUID(), username, hash, role]);
    }
  } finally { await pool.end(); }
  const { createApp } = await import('../../backend/dist/app.js');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  vite = await createViteServer({
    configFile: false,
    root: 'frontend',
    plugins: [react()],
    cacheDir: join(temporaryDirectory, 'vite-cache'),
    server: {
      host: '127.0.0.1', port, strictPort: true,
      proxy: { '/api': { target: await app.getUrl(), changeOrigin: false } },
    },
    logLevel: 'silent',
  });
  await vite.listen();
  await mkdir('.local/screenshots', { recursive: true, mode: 0o700 });
});

test.afterAll(async () => {
  try {
    try { await vite?.close(); } finally { await app?.close(); }
    if (ownsDatabase) await adminPool.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  } finally {
    await adminPool.end();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

async function login(page, username) {
  await page.goto(origin);
  await page.getByLabel('Nome de usuário', { exact: true }).fill(username);
  await page.getByLabel('Senha', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
}

async function games(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/games');
    if (!response.ok) throw new Error(`Catálogo retornou HTTP ${response.status}.`);
    return (await response.json()).games;
  });
}

async function expectCoverLoaded(card, name) {
  const image = card.getByRole('img', { name: `Capa de ${name}`, exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0)).toBe(true);
}

async function expectNoOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const theme of ['light', 'dark']) {
  test(`catálogo real GB + GBA ${theme}: identificar, cadastrar, editar e filtrar no celular`, async ({ page, browser }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await login(page, masterUsername);
    await page.getByRole('navigation').getByRole('button', { name: 'Catálogo', exact: true }).click();
    const name = `Sintético ${theme} ${randomBytes(3).toString('hex')}`;
    const gbaName = `GBA ${name}`;
    const editedName = `${name} editado`;
    for (const entry of [
      { name, console: 'GB', filename: 'synthetic.gb', rom: syntheticRom() },
      { name: gbaName, console: 'GBA', filename: 'synthetic.gba', rom: syntheticGbaRom() },
    ]) {
      await page.getByLabel('Nome do jogo', { exact: true }).fill(entry.name);
      await page.getByLabel('ROM (.gb ou .gba)', { exact: true }).setInputFiles({
        name: entry.filename, mimeType: 'application/octet-stream', buffer: entry.rom,
      });
      await expect(page.locator(`.rom-detection .console-badge[data-console="${entry.console}"]`)).toBeVisible();
      await page.getByLabel('Capa (opcional)', { exact: true }).setInputFiles({
        name: 'synthetic.png', mimeType: 'image/png', buffer: await syntheticCover(),
      });
      await page.getByLabel('Disponível para jogadores', { exact: true }).check();
      await page.getByRole('button', { name: 'Cadastrar jogo', exact: true }).click();
      const editButton = page.getByRole('button', { name: `Editar ${entry.name}`, exact: true });
      await expect(editButton).toBeVisible();
      await expect(page.locator('.catalogue-entry').filter({ has: editButton }).locator(`.console-badge[data-console="${entry.console}"]`)).toBeVisible();
    }
    const created = (await games(page)).find((game) => game.name === name);
    const createdGba = (await games(page)).find((game) => game.name === gbaName);
    expect(created).toBeDefined();
    expect(created.active).toBe(true);
    expect(created.console).toBe('GB');
    expect(createdGba.console).toBe('GBA');
    await page.screenshot({ path: `.local/screenshots/catalogue-${theme}-admin-desktop.png`, fullPage: true });

    await page.getByRole('navigation').getByRole('button', { name: 'Jogar', exact: true }).click();
    let card = page.getByRole('article', { name, exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: 'Jogar', exact: true })).toBeEnabled();
    await expect(card.locator('.console-badge[data-console="GB"]')).toContainText('Game Boy');
    await expectCoverLoaded(card, name);
    const gbaCard = page.getByRole('article', { name: gbaName, exact: true });
    await expect(gbaCard.locator('.console-badge[data-console="GBA"]')).toContainText('Game Boy Advance');
    await expect(gbaCard.getByRole('button', { name: 'Jogar', exact: true })).toBeEnabled();
    await expectCoverLoaded(gbaCard, gbaName);
    expect(await page.locator('a[download], a[href$=".gb"], a[href$=".gba"]').count()).toBe(0);

    const width = theme === 'dark' ? 320 : 390;
    const playerContext = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: theme });
    try {
      const player = await playerContext.newPage();
      player.on('pageerror', (error) => errors.push(error.message));
      await login(player, playerUsername);
      await expect(player.getByRole('button', { name: 'Catálogo', exact: true })).toHaveCount(0);
      await expect(player.getByRole('button', { name: 'Administração', exact: true })).toHaveCount(0);
      let playerCard = player.getByRole('article', { name, exact: true });
      await expect(playerCard).toBeVisible();
      await expect(playerCard.getByRole('button', { name: 'Jogar', exact: true })).toBeEnabled();
      await expect(playerCard.locator('.console-badge[data-console="GB"]')).toBeVisible();
      await expectCoverLoaded(playerCard, name);
      const playerGbaCard = player.getByRole('article', { name: gbaName, exact: true });
      await expect(playerGbaCard.locator('.console-badge[data-console="GBA"]')).toContainText('Game Boy Advance');
      await expectCoverLoaded(playerGbaCard, gbaName);
      await expectNoOverflow(player);
      await player.screenshot({ path: `.local/screenshots/catalogue-${theme}-player-${width}.png`, fullPage: true });

      await page.getByRole('navigation').getByRole('button', { name: 'Catálogo', exact: true }).click();
      await page.getByRole('button', { name: `Editar ${name}`, exact: true }).click();
      let dialog = page.getByRole('dialog', { name: 'Editar jogo', exact: true });
      await dialog.getByLabel('Nome do jogo', { exact: true }).fill(editedName);
      await dialog.getByLabel('Disponível para jogadores', { exact: true }).uncheck();
      await expect(dialog.getByLabel('ROM (.gb ou .gba)', { exact: true })).toHaveCount(0);
      await expect(dialog.locator('.console-badge[data-console="GB"]')).toBeVisible();
      await dialog.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const inactive = (await games(page)).find((game) => game.name === editedName);
      expect(inactive.id).toBe(created.id);
      expect(inactive.console).toBe('GB');
      expect(inactive.active).toBe(false);
      await player.reload();
      await expect(player.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
      await expect(player.getByRole('article', { name: editedName, exact: true })).toHaveCount(0);
      expect((await games(player)).some((game) => game.id === created.id)).toBe(false);
      expect((await games(player)).find((game) => game.id === createdGba.id).console).toBe('GBA');
      expect(await player.evaluate(async (url) => (await fetch(url)).status, created.coverUrl)).toBe(404);

      await page.getByRole('navigation').getByRole('button', { name: 'Jogar', exact: true }).click();
      await expect(page.getByRole('article', { name: editedName, exact: true }).getByRole('button', { name: 'Jogar', exact: true })).toBeDisabled();
      await page.getByRole('navigation').getByRole('button', { name: 'Catálogo', exact: true }).click();

      await page.getByRole('button', { name: `Editar ${editedName}`, exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Editar jogo', exact: true });
      await dialog.getByLabel('Disponível para jogadores', { exact: true }).check();
      await dialog.getByLabel('Nova capa (opcional)', { exact: true }).setInputFiles({
        name: 'replacement.jpg', mimeType: 'image/jpeg', buffer: await syntheticCover({ format: 'jpeg', background: '#ad7545' }),
      });
      await dialog.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
      await expect(dialog).toHaveCount(0);

      await page.getByRole('button', { name: `Editar ${gbaName}`, exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Editar jogo', exact: true });
      await expect(dialog.locator('.console-badge[data-console="GBA"]')).toContainText('Game Boy Advance');
      await expect(dialog.getByLabel('ROM (.gb ou .gba)', { exact: true })).toHaveCount(0);
      await dialog.getByLabel('Disponível para jogadores', { exact: true }).uncheck();
      await dialog.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await player.reload();
      await expect(player.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
      expect((await games(player)).some((game) => game.id === createdGba.id)).toBe(false);
      expect(await player.evaluate(async (url) => (await fetch(url)).status, createdGba.coverUrl)).toBe(404);
      await page.getByRole('button', { name: `Editar ${gbaName}`, exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Editar jogo', exact: true });
      await dialog.getByLabel('Disponível para jogadores', { exact: true }).check();
      await dialog.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await player.reload();
      await expect(player.getByRole('article', { name: gbaName, exact: true }).locator('.console-badge[data-console="GBA"]')).toBeVisible();
      expect((await games(page)).find((game) => game.id === createdGba.id).console).toBe('GBA');
      await player.reload();
      playerCard = player.getByRole('article', { name: editedName, exact: true });
      await expect(playerCard).toBeVisible();
      await expectCoverLoaded(playerCard, editedName);
      expect((await games(player)).find((game) => game.name === editedName).id).toBe(created.id);
      await expectNoOverflow(player);

      await page.setViewportSize({ width, height: 844 });
      await expectNoOverflow(page);
      await page.screenshot({ path: `.local/screenshots/catalogue-${theme}-admin-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: `Editar ${editedName}`, exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Editar jogo', exact: true });
      await expect(dialog.getByLabel('Remover capa atual', { exact: true })).toBeVisible();
      await page.screenshot({ path: `.local/screenshots/catalogue-${theme}-dialog-${width}.png`, fullPage: true });
      await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    } finally { await playerContext.close(); }
    expect(errors).toEqual([]);
  });
}
