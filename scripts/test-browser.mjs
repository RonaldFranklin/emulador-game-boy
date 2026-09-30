import { randomBytes } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { run, compose } from './docker.mjs';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const name = `emulador-game-boy-ui-${randomBytes(10).toString('hex')}`;
await mkdir('.local/screenshots', { recursive: true, mode: 0o700 });
await chmod('.local/screenshots', 0o700);
try {
  await run(compose('run', '--name', name, 'test-browser'), { output: process.stdout.fd });
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
  } catch { /* The random, run-owned container was never created. */ }
}
