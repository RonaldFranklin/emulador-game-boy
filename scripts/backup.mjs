import { mkdir, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { run, compose } from './docker.mjs';
import { createCatalogueBackup } from './catalog-backup.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
await mkdir('.local/backups', { recursive: true, mode: 0o700 });
await chmod('.local/backups', 0o700);
const backendContainer = await run(compose('ps', '-q', 'backend'));
const databaseContainer = await run(compose('ps', '-q', 'database'));
if (!backendContainer || !databaseContainer) throw new Error('Inicie backend e banco antes do backup.');
const path = `.local/backups/emulador-${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(4).toString('hex')}`;
try {
  const manifest = await createCatalogueBackup({ backendContainer, databaseContainer, outputPath: path });
  console.log(`Backup consistente concluído: ${path}`);
  console.log(`Banco + ${manifest.games.length} jogo(s) + ${manifest.files.length - 1} arquivo(s) privados + ${manifest.saves.length} save(s) nativo(s).`);
  console.log(`Verifique a restauração: npm run restore:verify -- ${path}`);
} catch (error) {
  console.error(`Backup incompleto em ${path}; não o use para restauração.`);
  throw error;
}
