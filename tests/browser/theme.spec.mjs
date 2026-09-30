import { test, expect } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createServer as createViteServer } from 'vite';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Theme-only browser tests: every /api request is intercepted. No Nest import,
// database connection, Docker operation, or real account is involved.
const themeKey = 'emulador-theme';
const masterUser = {
  id: '8a9bac44-0a42-4c90-a564-430d46e0e534',
  username: 'theme_master', role: 'MASTER', blocked: false,
  mustChangePassword: false, createdAt: '2026-01-02T12:00:00.000Z',
};
const playerUser = {
  id: 'a6b8a428-04b4-42e6-8c40-e44d33878e9e',
  username: 'theme_player', role: 'JOGADOR', blocked: false,
  mustChangePassword: false, createdAt: '2026-01-03T12:00:00.000Z',
};
let vite;
let cacheDirectory;
let origin;

test.beforeAll(async () => {
  cacheDirectory = await mkdtemp(join(tmpdir(), 'emulador-theme-vite-'));
  vite = await createViteServer({
    configFile: false,
    root: resolve('frontend'),
    plugins: [react()],
    cacheDir: cacheDirectory,
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'silent',
  });
  await vite.listen();
  origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await mkdir('.local/screenshots', { recursive: true, mode: 0o700 });
});

test.afterAll(async () => {
  try { await vite?.close(); }
  finally { if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true }); }
});

async function mockApi(context, { role = 'MASTER', authenticated = false, rejectLogin = false } = {}) {
  const state = { authenticated, unexpected: [], calls: [] };
  const session = { user: role === 'MASTER' ? masterUser : playerUser, csrfToken: randomBytes(32).toString('base64url') };
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    state.calls.push(`${method} ${path}`);
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (method === 'GET' && path === '/api/auth/me') {
      return state.authenticated ? json(session) : json({ message: 'Entre para continuar.' }, 401);
    }
    if (method === 'POST' && path === '/api/auth/login') {
      if (rejectLogin) return json({ message: 'Não foi possível entrar com os dados informados.' }, 401);
      state.authenticated = true;
      return json(session);
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      state.authenticated = false;
      return route.fulfill({ status: 204, body: '' });
    }
    if (method === 'GET' && path === '/api/games') return json({ games: [] });
    if (method === 'GET' && path === '/api/users') return json({ users: [masterUser, playerUser] });
    state.unexpected.push(`${method} ${path}`);
    return json({ message: 'Operação fora do escopo do teste de tema.' }, 418);
  });
  return state;
}

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function toggle(page) {
  return page.getByRole('button', { name: 'Tema escuro', exact: true });
}

async function expectTheme(page, theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', String(theme === 'dark'));
  await expect(toggle(page)).toContainText('Escuro');
  await expect(toggle(page)).toHaveAccessibleName('Tema escuro');
}

async function expectOnlyThemeStored(page, theme) {
  expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual({ [themeKey]: theme });
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
}

async function expectNoOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const button = await toggle(page).boundingBox();
  expect(button).not.toBeNull();
  expect(button.x).toBeGreaterThanOrEqual(0);
  expect(button.x + button.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
}

async function expectReadableSurface(locator, theme) {
  await expect(locator).toBeVisible();
  const colors = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const parse = (value) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    return { foreground: parse(style.color), background: parse(style.backgroundColor) };
  });
  expect(colors.foreground).toHaveLength(3);
  expect(colors.background).toHaveLength(3);
  const brightness = colors.background.reduce((sum, channel) => sum + channel, 0) / 3;
  if (theme === 'dark') expect(brightness).toBeLessThan(150);
  else expect(brightness).toBeGreaterThan(180);
  const luminance = (channels) => channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(colors.foreground), luminance(colors.background)].sort((a, b) => a - b);
  expect((values[1] + 0.05) / (values[0] + 0.05)).toBeGreaterThanOrEqual(4.5);
}

async function enterMockAccount(page, role = 'MASTER') {
  await page.getByLabel('Nome de usuário', { exact: true }).fill(role === 'MASTER' ? masterUser.username : playerUser.username);
  await page.getByLabel('Senha', { exact: true }).fill(randomBytes(16).toString('base64url'));
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
}

test('tema escuro e fundo inicial são aplicados antes de executar o módulo React', async ({ page, context }) => {
  const errors = watchErrors(page);
  await mockApi(context);
  await page.emulateMedia({ colorScheme: 'dark' });
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  await page.route(/\/src\/main\.tsx(?:\?|$)/, async (route) => {
    await gate;
    await route.continue();
  });
  const navigation = page.goto(origin);
  try {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#root')).toBeEmpty();
    const initial = await page.locator('html').evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, colorScheme: style.colorScheme };
    });
    const channels = initial.background.match(/[\d.]+/g).slice(0, 3).map(Number);
    expect(channels.reduce((sum, value) => sum + value, 0) / 3).toBeLessThan(150);
    expect(initial.colorScheme).toBe('dark');
  } finally {
    release();
    await navigation;
  }
  await expect(page.getByRole('heading', { name: 'Entre na sua conta' })).toBeVisible();
  await expectTheme(page, 'dark');
  expect(errors).toEqual([]);
});

test('acompanha o sistema até uma escolha explícita, sem gravar preferências automáticas', async ({ page, context }) => {
  await mockApi(context);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(origin);
  await expectTheme(page, 'light');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme(page, 'dark');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await toggle(page).click();
  await expectTheme(page, 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme(page, 'light');
  await expectOnlyThemeStored(page, 'light');
});

for (const theme of ['light', 'dark']) {
  test(`preferência explícita ${theme} prevalece sobre o sistema`, async ({ page, context }) => {
    await mockApi(context);
    await page.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: themeKey, value: theme });
    await page.goto(origin);
    await expectTheme(page, theme);
    await expectOnlyThemeStored(page, theme);
  });
}

for (const theme of ['light', 'dark']) {
 for (const role of ['MASTER', 'JOGADOR']) {
 test(`escolha ${theme} por teclado persiste no login, reload e logout ${role}, sem credenciais no storage`, async ({ page, context }) => {
  const state = await mockApi(context, { role });
  const errors = watchErrors(page);
  const opposite = theme === 'dark' ? 'light' : 'dark';
  await page.emulateMedia({ colorScheme: opposite });
  await page.goto(origin);
  await expectTheme(page, opposite);
  await toggle(page).focus();
  await page.keyboard.press('Space');
  await expect(toggle(page)).toBeFocused();
  expect(await toggle(page).evaluate((button) => getComputedStyle(button).outlineStyle)).toBe('solid');
  await expectTheme(page, theme);
  await expectOnlyThemeStored(page, theme);
  await enterMockAccount(page, role);
  await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
  await expectTheme(page, theme);
  await expectOnlyThemeStored(page, theme);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
  await expectTheme(page, theme);
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entre na sua conta' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Você saiu da sua conta.');
  await expectReadableSurface(page.locator('.alert-success'), theme);
  await page.reload();
  await expectTheme(page, theme);
  await expectOnlyThemeStored(page, theme);
  await toggle(page).focus();
  await page.keyboard.press('Enter');
  await expectTheme(page, opposite);
  expect(state.calls).toContain('POST /api/auth/logout');
  expect(state.unexpected).toEqual([]);
  expect(errors).toEqual([]);
 });
 }
}

test('preferência inválida segue o sistema e pode ser substituída pelo controle', async ({ page, context }) => {
  await mockApi(context);
  await page.emulateMedia({ colorScheme: 'dark' });
  await context.addInitScript((key) => localStorage.setItem(key, 'tema-invalido'), themeKey);
  await page.goto(origin);
  await expectTheme(page, 'dark');
  await toggle(page).click();
  await expectTheme(page, 'light');
  await expectOnlyThemeStored(page, 'light');
});

for (const failure of ['getItem', 'setItem', 'getter']) {
  test(`localStorage indisponível em ${failure} mantém a aplicação e o controle utilizáveis`, async ({ page, context }) => {
    const errors = watchErrors(page);
    await mockApi(context);
    await page.emulateMedia({ colorScheme: 'dark' });
    await context.addInitScript((operation) => {
      const denied = () => { throw new DOMException('Armazenamento indisponível neste teste.', 'SecurityError'); };
      if (operation === 'getter') Object.defineProperty(window, 'localStorage', { configurable: true, get: denied });
      else Object.defineProperty(Storage.prototype, operation, { configurable: true, value: denied });
    }, failure);
    await page.goto(origin);
    await expect(page.getByRole('heading', { name: 'Entre na sua conta' })).toBeVisible();
    await expectTheme(page, 'dark');
    await toggle(page).click();
    await expectTheme(page, 'light');
    await page.reload();
    await expectTheme(page, 'dark');
    expect(errors).toEqual([]);
  });
}

test('sem matchMedia, usa tema claro e permite alternar manualmente', async ({ page, context }) => {
  const errors = watchErrors(page);
  await mockApi(context);
  await context.addInitScript(() => Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined }));
  await page.goto(origin);
  await expectTheme(page, 'light');
  await toggle(page).click();
  await expectTheme(page, 'dark');
  expect(errors).toEqual([]);
});

test('escolha de tema é compartilhada entre abas da mesma origem', async ({ page, context }) => {
  await mockApi(context);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(origin);
  const second = await context.newPage();
  await second.emulateMedia({ colorScheme: 'light' });
  await second.goto(origin);
  await expectTheme(second, 'light');
  await toggle(page).click();
  await expectTheme(page, 'dark');
  await expectTheme(second, 'dark');
  await toggle(second).click();
  await expectTheme(second, 'light');
  await expectTheme(page, 'light');
  await expectOnlyThemeStored(page, 'light');
});

for (const theme of ['light', 'dark']) {
  for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
    test(`login ${theme} em ${viewport.name} apresenta campos e controle sem transbordamento`, async ({ page, context }) => {
      const errors = watchErrors(page);
      await mockApi(context);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(origin);
      await expectTheme(page, theme);
      await expect(page.locator('.login-brand-row')).toBeVisible();
      await expectReadableSurface(page.getByLabel('Nome de usuário', { exact: true }), theme);
      await expectReadableSurface(page.getByLabel('Senha', { exact: true }), theme);
      await expectNoOverflow(page);
      await page.screenshot({ path: `.local/screenshots/theme-login-${theme}-${viewport.name}.png`, fullPage: true });
      expect(errors).toEqual([]);
    });
  }

  test(`alerta de erro permanece legível no tema ${theme}`, async ({ page, context }) => {
    const state = await mockApi(context, { rejectLogin: true });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(origin);
    await enterMockAccount(page);
    await expect(page.getByRole('alert')).toContainText('Não foi possível entrar');
    await expectReadableSurface(page.getByRole('alert'), theme);
    await page.screenshot({ path: `.local/screenshots/theme-login-${theme}-alert.png`, fullPage: true });
    expect(state.unexpected).toEqual([]);
  });

  for (const role of ['MASTER', 'JOGADOR']) {
    for (const width of [1280, 390, 320]) {
      test(`cabeçalho e áreas ${role} em ${theme}, largura ${width}px`, async ({ page, context }) => {
        const state = await mockApi(context, { role, authenticated: true });
        const errors = watchErrors(page);
        await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(origin);
        await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
        await expectTheme(page, theme);
        await expect(page.locator('.header-actions')).toBeVisible();
        await expect(page.locator('.account-info')).toContainText(role === 'MASTER' ? masterUser.username : playerUser.username);
        await expectReadableSurface(page.locator('.empty-library'), theme);
        await expectNoOverflow(page);
        const oldBackground = await page.locator('.empty-library').evaluate((element) => getComputedStyle(element).backgroundColor);
        await toggle(page).click();
        await expect.poll(() => page.locator('.empty-library').evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(oldBackground);
        await toggle(page).click();
        await expectTheme(page, theme);
        await expectOnlyThemeStored(page, theme);
        await page.screenshot({ path: `.local/screenshots/theme-library-${role.toLowerCase()}-${theme}-${width}.png`, fullPage: true });

        if (role === 'MASTER') {
          await page.getByRole('button', { name: 'Administração', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'Jogadores', exact: true })).toBeVisible();
          await expectReadableSurface(page.locator('.users-card'), theme);
          await expectReadableSurface(page.locator('.create-card'), theme);
          await expectReadableSurface(page.getByLabel('Senha temporária', { exact: true }), theme);
          await expectNoOverflow(page);
          await page.screenshot({ path: `.local/screenshots/theme-admin-${theme}-${width}.png`, fullPage: true });
          await page.getByRole('button', { name: `Redefinir senha de ${playerUser.username}`, exact: true }).click();
          const dialog = page.getByRole('dialog');
          await expectReadableSurface(dialog, theme);
          await expectReadableSurface(dialog.getByLabel('Nova senha temporária', { exact: true }), theme);
          await page.screenshot({ path: `.local/screenshots/theme-dialog-${theme}-${width}.png`, fullPage: true });
          await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
          await expect(dialog).toHaveCount(0);
        } else {
          await expect(page.getByRole('button', { name: 'Administração', exact: true })).toHaveCount(0);
        }
        await page.getByRole('button', { name: 'Minha senha', exact: true }).click();
        await expectReadableSurface(page.locator('.password-card'), theme);
        await expectReadableSurface(page.getByLabel('Senha atual', { exact: true }), theme);
        await expectNoOverflow(page);
        expect(state.unexpected).toEqual([]);
        expect(state.calls.some((call) => call.startsWith('POST /api/users') || call.startsWith('PATCH '))).toBe(false);
        expect(errors).toEqual([]);
      });
    }
  }
}
