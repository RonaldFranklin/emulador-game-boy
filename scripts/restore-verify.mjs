import { open, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './docker.mjs';
import { verifyBackup } from './backup-file.mjs';
import { verifyCatalogueBackup } from './catalog-backup.mjs';
import { restoredGames, verifyRestoredCatalogue, verifyRestoredSaves } from './catalog-restore.mjs';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv.length !== 3) throw new Error('Uso: npm run restore:verify -- pasta/do/backup (ou dump legado sem jogos)');
const path = resolve(process.argv[2]);
const bundle = (await lstat(path)).isDirectory();
const manifest = bundle ? await verifyCatalogueBackup(path) : undefined;
if (!bundle) await verifyBackup(path);
const name = `emulador-game-boy-restore-${randomUUID()}`;
let created = false;
try {
  await run(['run', '--detach', '--name', name, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql:rw',
    '--mount', `type=bind,src=${resolve('.local/secrets/postgres_password')},dst=/run/secrets/db_password,readonly`,
    '--env', 'POSTGRES_PASSWORD_FILE=/run/secrets/db_password', '--env', 'POSTGRES_DB=emulador',
    'postgres:18.6-bookworm']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      // TCP readiness skips the initialization server, which listens only on its Unix socket.
      await run(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'emulador'], { quiet: true });
      ready = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!ready) throw new Error('PostgreSQL isolado não ficou pronto em 30 segundos.');
  const file = await open(bundle ? `${path}/database.dump` : path, 'r');
  try {
    await run(['exec', '-i', '--user', 'postgres', name, 'pg_restore', '-U', 'postgres', '-d', 'emulador',
      '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl'], { input: file.fd });
  } finally { await file.close(); }
  const games = await restoredGames(name, 'emulador');
  const saveCount = await verifyRestoredSaves(name, 'emulador', manifest);
  console.log(`Saves nativos restaurados e conferidos: ${saveCount}.`);
  if (bundle) {
    await run(['exec', name, 'mkdir', '-p', '/tmp/catalog-restored']);
    await run(['cp', `${path}/files/.`, `${name}:/tmp/catalog-restored`]);
  }
  await verifyRestoredCatalogue({ games, manifest, fileContainer: name, directory: '/tmp/catalog-restored' });
  const counts = await run(['exec', '--user', 'postgres', name, 'psql', '-U', 'postgres', '-d', 'emulador',
    '-At', '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT json_build_object('users', (SELECT count(*) FROM users), 'sessions', (SELECT count(*) FROM sessions), 'migrations', (SELECT count(*) FROM schema_migrations), 'usersFingerprint', (SELECT md5(coalesce(string_agg(row_to_json(u)::text, '' ORDER BY id), '')) FROM users u));`]);
  console.log(`Restauração isolada validada (checksum + pg_restore transacional + leitura): ${counts}`);
  if (bundle) console.log(`Catálogo restaurado e conferido: ${games.length} jogo(s), ${manifest.files.length - 1} arquivo(s), hashes iguais aos metadados e manifesto.`);
  if (bundle) console.log(`Tipos conferidos no banco restaurado: GB=${games.filter(game => game.console === 'GB').length}, GBA=${games.filter(game => game.console === 'GBA').length}.`);
  console.log('Banco ativo preservado; container temporário sem rede/portas e sem volume persistente.');
} finally {
  if (created) await run(['rm', '--force', name]);
}
