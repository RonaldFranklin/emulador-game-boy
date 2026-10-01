import { randomBytes } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { run } from './docker.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const image = 'emulador-game-boy-browser:dev';
const name = `emulador-game-boy-player-ux-${randomBytes(10).toString('hex')}`;
await mkdir('.local/screenshots', { recursive: true, mode: 0o700 });
await chmod('.local/screenshots', 0o700);

try {
  try { await run(['image', 'inspect', image], { quiet: true }); }
  catch { throw new Error('Prepare a imagem do navegador: docker compose build test-browser'); }
  // No database, credentials, external network, published port or Compose dependency.
  await run([
    'run', '--name', name, '--init', '--network', 'none', '--ipc', 'private', '--shm-size', '1g',
    // Keep the already-built, unchanged core assets from the browser image.
    '--mount', `type=bind,src=${root}/frontend/src,dst=/app/frontend/src,readonly`,
    '--mount', `type=bind,src=${root}/frontend/index.html,dst=/app/frontend/index.html,readonly`,
    '--mount', `type=bind,src=${root}/tests/browser/player-ux.spec.mjs,dst=/app/tests/browser/player-ux.spec.mjs,readonly`,
    '--mount', `type=bind,src=${root}/playwright.config.ts,dst=/app/playwright.config.ts,readonly`,
    image, 'npx', '--no-install', 'playwright', 'test', 'player-ux.spec.mjs',
  ], { output: process.stdout.fd });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    await run(['inspect', name], { quiet: true });
    try {
      await run(['cp', `${name}:/app/.local/screenshots/.`, '.local/screenshots']);
      console.log('Capturas disponíveis em .local/screenshots/.');
    } catch { console.error('O teste terminou sem capturas para copiar.'); }
    await run(['rm', '--force', name]);
  } catch { /* Only this run's random container may be removed. */ }
}
