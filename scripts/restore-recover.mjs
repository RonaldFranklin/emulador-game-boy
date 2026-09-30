import { open, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, compose } from './docker.mjs';
import { verifyBackup } from './backup-file.mjs';
import { verifyCatalogueBackup } from './catalog-backup.mjs';
import { restoredGames, verifyRestoredCatalogue, verifyRestoredSaves } from './catalog-restore.mjs';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv.length !== 3) throw new Error('Uso: npm run restore:recover -- pasta/do/backup (ou dump legado sem jogos)');
const path = resolve(process.argv[2]);
const bundle = (await lstat(path)).isDirectory();
const manifest = bundle ? await verifyCatalogueBackup(path) : undefined;
if (!bundle) await verifyBackup(path);
const database = `emulador_recovered_${randomBytes(10).toString('hex')}`;
const volume = `emulador-game-boy-recovered-${randomBytes(10).toString('hex')}`;
const helper = `emulador-game-boy-recovery-${randomBytes(10).toString('hex')}`;
let ownsHelper = false;
let ownsVolume = false;
const databaseContainer = await run(compose('ps', '-q', 'database'));
await run(compose('exec', '-T', '--user', 'postgres', 'database', 'createdb', '-U', 'postgres',
  '--template=template0', '--owner=emulador', database));
const file = await open(bundle ? `${path}/database.dump` : path, 'r');
try {
  await run(compose('exec', '-T', '--user', 'postgres', 'database', 'pg_restore', '-U', 'postgres', '-d', database,
    '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--role=emulador'), { input: file.fd });
  await run(compose('exec', '-T', '--user', 'postgres', 'database', 'psql', '-U', 'postgres', '-d', database,
    '-v', 'ON_ERROR_STOP=1', '-c', 'DELETE FROM sessions; REVOKE CREATE ON SCHEMA public FROM PUBLIC;'));
  const games = await restoredGames(databaseContainer, database);
  const saveCount = await verifyRestoredSaves(databaseContainer, database, manifest);
  console.log(`Saves nativos recuperados e conferidos: ${saveCount}.`);
  if (!bundle && games.length) throw new Error('Dump com jogos exige backup completo com arquivos.');
  // A fresh volume keeps both the active files and earlier recovery attempts intact.
  await run(['volume', 'create', volume]);
  ownsVolume = true;
  await run(['run', '--detach', '--name', helper, '--network', 'none', '--user', '0',
    '--mount', `type=volume,src=${volume},dst=/data/catalog`,
    'emulador-game-boy-backend:dev', 'sleep', 'infinity']);
  ownsHelper = true;
  if (bundle) await run(['cp', `${path}/files/.`, `${helper}:/data/catalog`]);
  await run(['exec', helper, 'chown', '-R', '1000:1000', '/data/catalog']);
  await run(['exec', helper, 'chmod', '0700', '/data/catalog', '/data/catalog/roms', '/data/catalog/covers']);
  await verifyRestoredCatalogue({ games, manifest, fileContainer: helper, directory: '/data/catalog' });
  console.log(`Tipos recuperados e conferidos: GB=${games.filter(game => game.console === 'GB').length}, GBA=${games.filter(game => game.console === 'GBA').length}. Migrações pendentes serão aplicadas na ativação.`);
} catch (error) {
  console.error(`Falha na recuperação. Banco ativo preservado; destino não ativado: ${database}`);
  if (ownsVolume) console.error(`Volume novo não ativado, preservado para diagnóstico: ${volume}`);
  throw error;
} finally {
  await file.close();
  if (ownsHelper) await run(['rm', '--force', helper]);
}
console.log(`Recuperação concluída em um NOVO banco: ${database}`);
console.log('Sessões restauradas foram revogadas. Banco ativo e .env permanecem preservados.');
console.log(`APP_DB_NAME=${database}`);
console.log(`CATALOG_VOLUME=${volume}`);
console.log('Para ativar, siga docs/operacao.md: parar backend, configurar os destinos acima, executar migrações/bootstrap e recriar backend/frontend sem dependências.');
