import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { run } from './docker.mjs';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const assetPath = new RegExp(`^(roms/${uuid}\\.gba?|covers/${uuid}\\.png)$`);
const filePath = new RegExp(`^(database\\.dump|files/(roms/${uuid}\\.gba?|covers/${uuid}\\.png))$`);

export async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Same database lock as catalogue writes; EOF/timeout releases the lock even
// when the host command is interrupted. Other application areas keep working.
const lockCode = `
  import pg from 'pg';
  import { databaseConfig } from './backend/dist/config.js';
  const client = new pg.Client(databaseConfig());
  const timer = setTimeout(() => { client.end().finally(() => process.exit(1)); }, 30 * 60_000);
  try {
    await client.connect();
    const present = (await client.query("SELECT to_regclass('public.games') IS NOT NULL AS present")).rows[0].present;
    // Legacy authentication-only backends have neither this module nor storage.
    const key = present ? (await import('./backend/dist/games/catalog-constants.js')).CATALOG_LOCK_KEY : 781004;
    await client.query('SELECT pg_advisory_lock($1)', [key]);
    const typed = present && (await client.query("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='games' AND column_name='console') AS present")).rows[0].present;
    const consoleColumn = typed ? 'console' : "'GB'::text AS console";
    const rows = present ? (await client.query('SELECT id, ' + consoleColumn + ', rom_key, rom_sha256, rom_size, cover_key, cover_sha256, cover_size FROM games ORDER BY id')).rows : [];
    const hasSaves = (await client.query("SELECT to_regclass('public.game_saves') IS NOT NULL AS present")).rows[0].present;
    const saves = hasSaves ? (await client.query('SELECT user_id, game_id, sha256, size, version FROM game_saves ORDER BY user_id, game_id')).rows : [];
    if (hasSaves && (await client.query("SELECT 1 FROM game_saves WHERE size <> octet_length(data) OR sha256 <> encode(sha256(data), 'hex') LIMIT 1")).rowCount) throw new Error('Invalid savedata integrity');
    const hasStates = (await client.query("SELECT to_regclass('public.save_states') IS NOT NULL AS present")).rows[0].present;
    const states = hasStates ? (await client.query('SELECT user_id,game_id,slot,version,label,console,rom_sha256,core_id,format,sha256,native_sha256,octet_length(data) AS size,octet_length(native) AS native_size FROM save_states WHERE data IS NOT NULL ORDER BY user_id,game_id,slot')).rows : [];
    const resets = hasStates ? (await client.query('SELECT user_id,game_id,epoch FROM save_resets ORDER BY user_id,game_id')).rows : [];
    if (hasStates && (await client.query("SELECT 1 FROM save_states WHERE data IS NOT NULL AND (sha256 <> encode(sha256(data),'hex') OR native_sha256 <> encode(sha256(native),'hex')) LIMIT 1")).rowCount) throw new Error('Invalid state integrity');
    process.stdout.write(JSON.stringify({ states, resets, saves, database: process.env.PGDATABASE, storagePath: present ? process.env.CATALOG_STORAGE_DIR : null, hasCatalog: present, games: rows }) + '\\n');
    for await (const chunk of process.stdin) { if (chunk.length) break; }
  } catch { process.stderr.write('Não foi possível manter a trava de backup do catálogo.\\n'); process.exitCode = 1; }
  finally { clearTimeout(timer); await client.end(); }
`;

async function lockCatalogue(container) {
  const child = spawn('docker', ['exec', '-i', container, 'node', '--input-type=module', '-e', lockCode], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let output = '', errorOutput = '', snapshot;
  const completed = new Promise((resolveExit) => {
    child.once('error', () => resolveExit(-1));
    child.once('close', (code) => resolveExit(code));
  });
  child.stderr.on('data', (chunk) => { errorOutput += chunk; });
  try {
    snapshot = await new Promise((resolveSnapshot, reject) => {
      child.once('error', reject);
      child.once('close', () => reject(new Error(errorOutput || 'Trava de backup interrompida.')));
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (!output.includes('\n')) return;
        try { resolveSnapshot(JSON.parse(output.slice(0, output.indexOf('\n')))); }
        catch { reject(new Error('Resposta inválida da trava de backup.')); }
      });
    });
  } catch (error) { child.stdin.end(); await completed; throw error; }
  return {
    snapshot,
    assertHeld() { if (child.exitCode !== null || child.signalCode !== null) throw new Error('Trava perdida; backup incompleto.'); },
    async release() {
      child.stdin.end('\n');
      if (await completed !== 0) throw new Error(errorOutput || 'Trava perdida; backup incompleto.');
    },
  };
}

// v1 predates the console column and can contain only GB. Never infer a GBA
// type from an old manifest or silently fix an invalid explicit discriminator.
export function normalizeGames(games, version = 2) {
  if (!Array.isArray(games) || games.length > 1000) throw new Error('Lista de jogos inválida no backup.');
  return games.map((game) => {
    const console = version === 1 && game.console === undefined ? 'GB' : game.console;
    if (!['GB', 'GBA'].includes(console) || (version === 1 && console !== 'GB')) throw new Error('Console inválido no manifesto.');
    return { id: game.id, console, rom_key: game.rom_key, rom_sha256: game.rom_sha256,
      rom_size: game.rom_size, cover_key: game.cover_key, cover_sha256: game.cover_sha256, cover_size: game.cover_size };
  });
}

export function verifyReferences(games, files) {
  if (!Array.isArray(games) || games.length > 1000) throw new Error('Lista de jogos inválida no backup.');
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const game of games) {
    const limits = game.console === 'GB' ? [32768, 8388608, '.gb'] : game.console === 'GBA' ? [192, 33554432, '.gba'] : null;
    if (!limits || typeof game.rom_key !== 'string' || !game.rom_key.endsWith(limits[2]) ||
        !Number.isSafeInteger(game.rom_size) || game.rom_size < limits[0] || game.rom_size > limits[1]) {
      throw new Error('Console, extensão ou tamanho da ROM divergentes no catálogo.');
    }
    for (const [directory, key, hash, size] of [
      ['roms', game.rom_key, game.rom_sha256, game.rom_size],
      ['covers', game.cover_key, game.cover_sha256, game.cover_size],
    ]) {
      if (directory === 'covers' && key === null && hash === null && size === null) continue;
      const path = `${directory}/${key}`;
      if (!assetPath.test(path)) throw new Error('Caminho inválido no catálogo restaurado.');
      const file = byPath.get(`files/${path}`);
      if (!file || file.sha256 !== hash || file.size !== size) throw new Error(`Arquivo ausente ou divergente do banco: ${path}`);
    }
  }
}

async function assetFiles(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Pasta de arquivos inválida.');
  const files = [];
  for (const folder of await readdir(directory, { withFileTypes: true })) {
    if (!folder.isDirectory() || !['roms', 'covers'].includes(folder.name)) throw new Error('Diretório inesperado no armazenamento do catálogo.');
    for (const item of await readdir(join(directory, folder.name), { withFileTypes: true })) {
      const path = `${folder.name}/${item.name}`;
      if (!item.isFile() || !assetPath.test(path)) throw new Error('Arquivo inesperado no armazenamento do catálogo.');
      files.push(path);
      if (files.length > 10000) throw new Error('Limite de arquivos do catálogo excedido.');
    }
  }
  return files.sort();
}

export async function createCatalogueBackup({ backendContainer, databaseContainer, outputPath }) {
  await mkdir(outputPath, { mode: 0o700 });
  const lock = await lockCatalogue(backendContainer);
  let manifest;
  try {
    const { database, storagePath, hasCatalog, games, saves, states, resets } = lock.snapshot;
    if (!database || (hasCatalog && !storagePath?.startsWith('/'))) throw new Error('Configuração do backend incompleta para backup.');
    const dump = await open(join(outputPath, 'database.dump'), 'wx', 0o600);
    try {
      await run(['exec', '--user', 'postgres', databaseContainer, 'pg_dump', '-U', 'postgres', '-d', database,
        '--format=custom', '--no-owner', '--no-acl'], { output: dump.fd });
    } finally { await dump.close(); }
    await mkdir(join(outputPath, 'files'), { mode: 0o700 });
    if (hasCatalog) await run(['cp', `${backendContainer}:${storagePath}/.`, join(outputPath, 'files')]);
    else {
      await mkdir(join(outputPath, 'files', 'roms'), { mode: 0o700 });
      await mkdir(join(outputPath, 'files', 'covers'), { mode: 0o700 });
    }
    lock.assertHeld();
    const paths = ['database.dump', ...(await assetFiles(join(outputPath, 'files'))).map((path) => `files/${path}`)];
    const files = [];
    for (const path of paths) {
      const absolute = join(outputPath, path);
      const info = await lstat(absolute);
      if (!info.isFile()) throw new Error('Backup contém arquivo não regular.');
      await chmod(absolute, 0o600);
      files.push({ path, size: info.size, sha256: await digest(absolute) });
    }
    verifyReferences(games, files);
    verifySaveMetadata(saves, games);
    verifyStateMetadata(states,games);
    manifest = { version: 4, states, resets, saves, createdAt: new Date().toISOString(), sourceDatabase: database, games, files };
    lock.assertHeld();
  } finally { await lock.release(); }
  // Manifest is the completion marker: incomplete bundles cannot restore.
  const path = join(outputPath, 'manifest.json');
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(`${path}.sha256`, `${await digest(path)}\n`, { flag: 'wx', mode: 0o600 });
  return manifest;
}

export async function verifyCatalogueBackup(directory) {
  const root = resolve(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error('Informe uma pasta de backup completa.');
  for (const name of ['manifest.json', 'manifest.json.sha256', 'database.dump']) {
    if (!(await lstat(join(root, name))).isFile()) throw new Error('Arquivo de backup não regular.');
  }
  if ((await lstat(join(root, 'manifest.json'))).size > 8 * 1024 * 1024) throw new Error('Manifesto excede o limite.');
  if (await digest(join(root, 'manifest.json')) !== (await readFile(join(root, 'manifest.json.sha256'), 'utf8')).trim()) {
    throw new Error('Checksum do manifesto inválido.');
  }
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (![1, 2, 3, 4].includes(manifest.version) || !Array.isArray(manifest.files) || manifest.files.length > 10001) throw new Error('Formato de backup não suportado.');
  const expected = ['database.dump', ...(await assetFiles(join(root, 'files'))).map((path) => `files/${path}`)].sort();
  const actual = manifest.files.map((file) => file.path).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Lista de arquivos diverge do manifesto.');
  for (const file of manifest.files) {
    if (!filePath.test(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 ||
        (file.path === 'database.dump' && file.size === 0) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Entrada inválida no manifesto.');
    const path = join(root, file.path);
    const info = await lstat(path);
    if (!info.isFile() || info.size !== file.size || await digest(path) !== file.sha256) throw new Error(`Checksum/tamanho inválido: ${file.path}`);
  }
  if (manifest.version === 1 && manifest.files.some((file) => file.path.endsWith('.gba'))) throw new Error('Backup v1 aceita somente ROMs GB.');
  verifyReferences(normalizeGames(manifest.games, manifest.version), manifest.files);
  verifySaveMetadata(manifest.version >= 3 ? manifest.saves : [], manifest.games);
  verifyStateMetadata(manifest.version >= 4 ? manifest.states : [], manifest.games);
  return manifest;
}

// Native saves live atomically inside database.dump, not in a public file tree.
export function verifySaveMetadata(saves, games) {
  if (!Array.isArray(saves) || saves.length > 10000) throw new Error('Lista de saves inválida no backup.');
  const gameIds = new Set(games.map(game => game.id));
  const seen = new Set();
  let bytes = 0;
  for (const save of saves) {
    const key = `${save.user_id}:${save.game_id}`;
    if (!new RegExp(`^${uuid}$`).test(save.user_id) || !gameIds.has(save.game_id) || seen.has(key) ||
        !/^[a-f0-9]{64}$/.test(save.sha256) || !Number.isInteger(save.version) || save.version < 1 ||
        !Number.isInteger(save.size) || save.size < 1 || save.size > 1048576) throw new Error('Metadados de save inválidos no backup.');
    seen.add(key); bytes += save.size;
  }
  if (bytes > 1024 ** 3) throw new Error('Quota de saves excedida no backup.');
}

export function verifyStateMetadata(states, games) {
 if(!Array.isArray(states)||states.length>10000)throw Error('Lista de estados inválida.');
 const seen=new Set(),owners=new Map();let total=0;
 for(const state of states){
  const game=games.find(g=>g.id===state.game_id),key=`${state.user_id}:${state.game_id}:${state.slot}`;
  if(!new RegExp(`^${uuid}$`).test(state.user_id)||!game||seen.has(key)||![0,1,2,3].includes(state.slot)||!Number.isInteger(state.version)||state.version<1||state.format!==1||state.console!==game.console||state.rom_sha256!==game.rom_sha256||!/^wasm:[a-f0-9]{64}$/.test(state.core_id)||!Number.isInteger(state.size)||state.size!==(state.console==='GB'?71680:397312)||!Number.isInteger(state.native_size)||state.native_size<0||state.native_size>1048576||!/^[a-f0-9]{64}$/.test(state.sha256)||!/^[a-f0-9]{64}$/.test(state.native_sha256))throw Error('Metadados de estado inválidos.');
  seen.add(key);const bytes=state.size+state.native_size;total+=bytes;owners.set(state.user_id,(owners.get(state.user_id)??0)+bytes);
 }
 if(total>256*1024**2||[...owners.values()].some(n=>n>32*1024**2))throw Error('Quota de estados excedida no backup.');
}
