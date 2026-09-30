import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { run, compose } from './docker.mjs';
import { createCatalogueBackup, verifyCatalogueBackup, digest } from './catalog-backup.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const suffix = randomBytes(10).toString('hex');
const database = `emulador_catalog_test_${suffix}`;
const source = `emulador-game-boy-catalog-test-${suffix}`;
const sourceVolume = `emulador-game-boy-catalog-test-${suffix}`;
const restoredApi = `emulador-game-boy-catalog-recovered-test-${suffix}`;
const password = randomBytes(24).toString('base64url');
const bundle = `.local/backups/catalogue-operational-${suffix}`;
let ownsDatabase = false, ownsSource = false, ownsVolume = false, ownsRestoredApi = false;
let recoveredDatabase, recoveredVolume;

function command(program, args, input) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code) => {
      const message = `${stdout}\n${stderr}`.replaceAll(password, '[omitido]');
      if (code !== 0) reject(new Error(`Verificação operacional falhou (${code}): ${message}`));
      else resolveCommand(stdout.trim());
    });
    child.stdin.end(input);
  });
}
const sql = (target, query) => run(compose('exec', '-T', '--user', 'postgres', 'database', 'psql', '-U', 'postgres', '-d', target, '-At', '-v', 'ON_ERROR_STOP=1', '-c', query), { quiet: true });
async function ready(container) {
  for (let i = 0; i < 40; i++) {
    try {
      await run(['exec', container, 'node', '-e', "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { quiet: true });
      return;
    } catch { await sleep(500); }
  }
  throw new Error('API de teste não ficou pronta.');
}

const exercise = `
  import assert from 'node:assert/strict';
  import { createHash, randomUUID } from 'node:crypto';
  import pg from 'pg';
  import argon2 from 'argon2';
  import { databaseConfig } from './backend/dist/config.js';
  import { syntheticRom, syntheticGbaRom, syntheticCover } from './tests/helpers/catalog-fixtures.mjs';
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const options = JSON.parse(input); input = '';
  if (options.seed) {
    assert.match(process.env.PGDATABASE, /^emulador_catalog_test_[a-f0-9]{20}$/);
    const client = new pg.Client(databaseConfig()); await client.connect();
    try {
      assert.equal((await client.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
      await client.query("INSERT INTO users(id,username,password_hash,role,must_change_password) VALUES($1,'catalog_ops',$2,'MASTER',false)",
        [randomUUID(), await argon2.hash(options.password, {type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1})]);
    } finally { await client.end(); }
  }
  let cookie, csrf;
  const request = async (path, method='GET', body) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET') {
      headers.Origin = 'http://127.0.0.1:5173'; headers['X-Requested-With']='XMLHttpRequest';
      if (csrf) headers['X-CSRF-Token']=csrf;
      if (!(body instanceof FormData)) { headers['Content-Type']='application/json'; body=JSON.stringify(body??{}); }
    }
    const response = await fetch('http://127.0.0.1:3001'+path,{method,headers,body,signal:AbortSignal.timeout(15000)});
    assert.ok(response.ok, 'API de teste deve aceitar a operação: '+response.status);
    return response;
  };
  const login = await request('/api/auth/login','POST',{username:'catalog_ops',password:options.password});
  cookie = login.headers.get('set-cookie').split(';')[0]; csrf=(await login.json()).csrfToken;
  const data = (fields, files={}) => {
    const form = new FormData();
    for (const [key,value] of Object.entries(fields)) form.append(key,String(value));
    for (const [key,file] of Object.entries(files)) form.append(key,new Blob([file.bytes]),file.name);
    return form;
  };
  let coverId=options.expected?.coverId;
  if (options.seed) {
    const created = await (await request('/api/games','POST',data({name:'Catálogo sintético',active:false},{
      rom:{bytes:syntheticRom(),name:'synthetic.gb'},cover:{bytes:await syntheticCover(),name:'cover.png'}
    }))).json();
    coverId=created.game.id;
    await request('/api/games/'+coverId,'PATCH',data({name:'Catálogo sintético renomeado',active:true},{cover:{bytes:await syntheticCover({format:'jpeg',background:'#41652e'}),name:'replacement.jpg'}}));
    await request('/api/games','POST',data({name:'Advance sintético',active:true},{rom:{bytes:syntheticGbaRom(),name:'synthetic.gba'}}));
  }
  const games=(await (await request('/api/games')).json()).games;
  assert.equal(games.length,2);
  assert.deepEqual(games.map(game=>game.console).sort(),['GB','GBA']);
  const saves=[];
  for (const game of games) {
    const lease=await (await request('/api/play/'+game.id+'/lease','POST')).json();
    if(options.seed) {
      const bytes=Buffer.alloc(game.console==='GB'?8192:32768,game.console==='GB'?71:65);
      await request('/api/play/'+game.id+'/save','PUT',{leaseId:lease.leaseId,baseVersion:0,dataBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')});
    } else {
      assert.equal(lease.save.version,1);
      assert.equal(Buffer.from(lease.save.dataBase64,'base64')[0],game.console==='GB'?71:65);
    }
    await request('/api/play/'+game.id+'/lease','DELETE',{leaseId:lease.leaseId});
    const check=await (await request('/api/play/'+game.id+'/lease','POST')).json();
    saves.push({gameId:game.id,version:check.save.version,sha256:check.save.sha256});
    await request('/api/play/'+game.id+'/lease','DELETE',{leaseId:check.leaseId});
  }
  const cover=Buffer.from(await (await request('/api/games/'+coverId+'/cover')).arrayBuffer());
  const snapshot={games,saves,coverId,coverHash:createHash('sha256').update(cover).digest('hex')};
  if(options.expected) assert.deepEqual(snapshot,options.expected);
  await request('/api/auth/logout','POST');
  process.stdout.write(JSON.stringify(snapshot));
`;
const exerciseApi = async (container, options) => JSON.parse(await command('docker', ['exec', '-i', container, 'node', '--input-type=module', '-e', exercise], JSON.stringify({ password, ...options })));

try {
  const config = JSON.parse(await run(compose('config', '--format', 'json')));
  assert.equal(config.name, 'emulador-game-boy-dev');
  const databaseContainer = await run(compose('ps', '-q', 'database'));
  assert.ok(databaseContainer);
  await run(compose('exec', '-T', '--user', 'postgres', 'database', 'createdb', '-U', 'postgres', '--template=template0', '--owner=emulador', database));
  ownsDatabase = true;
  await run(compose('run', '--rm', '--no-deps', '-T', '-e', `PGDATABASE=${database}`, 'migrate'), { quiet: true });
  await run(['volume', 'create', sourceVolume]); ownsVolume = true;
  await run(compose('run', '--detach', '--no-deps', '--name', source,
    '-v', `${sourceVolume}:/data/catalog`, '-e', `PGDATABASE=${database}`, '-e', 'CATALOG_STORAGE_DIR=/data/catalog',
    'test', 'npm', 'run', 'start', '--workspace', 'backend'), { quiet: true });
  ownsSource = true;
  await ready(source);
  const expected = await exerciseApi(source, { seed: true });
  await run(['restart', source], { quiet: true });
  await ready(source);
  await exerciseApi(source, { expected });
  console.log('Catálogo: upload, edição e reinício real do container preservaram UUIDs, consoles GB/GBA, metadados e capa em volume próprio.');

  // Simulate an unreferenced zero-byte residue left by an interrupted upload.
  await run(['exec', source, 'node', '--input-type=module', '-e',
    "import {writeFile} from 'node:fs/promises'; import {randomUUID} from 'node:crypto'; await writeFile('/data/catalog/covers/'+randomUUID()+'.png', Buffer.alloc(0), {flag:'wx',mode:0o600});"]);
  await mkdir('.local/backups', { recursive: true, mode: 0o700 });
  const manifest = await createCatalogueBackup({ backendContainer: source, databaseContainer, outputPath: bundle });
  assert.equal(manifest.version, 3);
  assert.equal(manifest.saves.length,2);
  assert.equal(manifest.games.length, 2);
  assert.deepEqual(manifest.games.map(game=>game.console).sort(), ['GB', 'GBA']);
  assert.equal(manifest.files.length - 1, 5); // two ROMs, active/retired covers, empty orphan
  await verifyCatalogueBackup(bundle);
  const manifestPath = `${bundle}/manifest.json`;
  const checksumPath = `${manifestPath}.sha256`;
  const originalManifest = await readFile(manifestPath);
  const originalChecksum = await readFile(checksumPath);
  try {
    const changed = JSON.parse(originalManifest);
    changed.games.find(game => game.console === 'GBA').console = 'GB';
    await writeFile(manifestPath, JSON.stringify(changed));
    await writeFile(checksumPath, `${await digest(manifestPath)}\n`);
    await assert.rejects(() => verifyCatalogueBackup(bundle), /Console, extensão ou tamanho/);
  } finally {
    await writeFile(manifestPath, originalManifest);
    await writeFile(checksumPath, originalChecksum);
  }
  const restored = await command(process.execPath, ['scripts/restore-verify.mjs', bundle]);
  assert.match(restored, /Catálogo restaurado e conferido: 2 jogo\(s\), 5 arquivo\(s\)/);
  console.log('Backup/restauração sem rede: GB + GBA, dois saves nativos, dois jogos e cinco arquivos (capa anterior e resíduo vazio incluídos) íntegros.');

  // Corrupt only a synthetic file in this test-owned bundle, never active storage.
  const asset = manifest.files.find((file) => file.path.startsWith('files/roms/'));
  const original = await readFile(`${bundle}/${asset.path}`);
  try {
    await writeFile(`${bundle}/${asset.path}`, Buffer.from('corrompido'));
    await assert.rejects(() => verifyCatalogueBackup(bundle), /Checksum\/tamanho inválido/);
  } finally { await writeFile(`${bundle}/${asset.path}`, original, { mode: 0o600 }); }
  await verifyCatalogueBackup(bundle);
  console.log('Arquivo adulterado no backup foi recusado antes da restauração.');

  const recovery = await command(process.execPath, ['scripts/restore-recover.mjs', bundle]);
  recoveredDatabase = recovery.match(/NOVO banco: (emulador_recovered_[a-f0-9]{20})/)?.[1];
  recoveredVolume = recovery.match(/^CATALOG_VOLUME=(emulador-game-boy-recovered-[a-f0-9]{20})$/m)?.[1];
  assert.ok(recoveredDatabase); assert.ok(recoveredVolume);
  assert.equal(await sql(recoveredDatabase, 'SELECT count(*) FROM sessions'), '0');
  await run(['run', '--detach', '--name', restoredApi, '--network', `${config.name}_private`,
    '--mount', `type=volume,src=${recoveredVolume},dst=/data/catalog`,
    '--mount', `type=bind,src=${resolve('.local/secrets/app_db_password')},dst=/run/secrets/app_db_password,readonly`,
    '--env', 'PGHOST=database', '--env', 'PGUSER=emulador', '--env', `PGDATABASE=${recoveredDatabase}`,
    '--env', 'PGPASSWORD_FILE=/run/secrets/app_db_password', '--env', 'CATALOG_STORAGE_DIR=/data/catalog',
    'emulador-game-boy-backend:dev'], { quiet: true });
  ownsRestoredApi = true;
  await ready(restoredApi);
  await exerciseApi(restoredApi, { expected });
  await exerciseApi(source, { expected });
  console.log('Recuperação em novo banco/volume e saves: API com papel emulador autenticou e serviu catálogo/capa idênticos; origem preservada.');
  console.log(`Evidência sintética preservada em ${bundle}.`);
} finally {
  const failures = [];
  for (const container of [ownsRestoredApi && restoredApi, ownsSource && source].filter(Boolean)) {
    try { await run(['rm', '--force', container], { quiet: true }); } catch (error) { failures.push(error.message); }
  }
  for (const target of [recoveredDatabase, ownsDatabase && database].filter(Boolean)) {
    try { await run(compose('exec', '-T', '--user', 'postgres', 'database', 'dropdb', '-U', 'postgres', '--force', target), { quiet: true }); }
    catch (error) { failures.push(error.message); }
  }
  for (const volume of [recoveredVolume, ownsVolume && sourceVolume].filter(Boolean)) {
    try { await run(['volume', 'rm', volume], { quiet: true }); } catch (error) { failures.push(error.message); }
  }
  if (failures.length) throw new Error(`Limpeza de recursos exclusivos do teste incompleta: ${failures.join('; ')}`);
}
