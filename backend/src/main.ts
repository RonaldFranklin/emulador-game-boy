import { createApp } from './app.js';
import { readConfig } from './config.js';

try {
  const config = readConfig();
  const app = await createApp();
  await app.listen(config.port, config.host);
} catch {
  console.error('Não foi possível iniciar o backend. Confira configuração, banco e migrações.');
  process.exitCode = 1;
}
