import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { run, compose } from './docker.mjs';
import { createCatalogueBackup, verifyCatalogueBackup } from './catalog-backup.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const suffix = randomBytes(10).toString('hex');
const database = `emulador_states_test_${suffix}`;
const source = `emulador-game-boy-states-test-${suffix}`;
const password = randomBytes(24).toString('base64url');
const bundle = `.local/backups/states-operational-${suffix}`;
let ownsDatabase = false, ownsSource = false;

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
 import {createHash,randomUUID} from 'node:crypto';
 import {readFile} from 'node:fs/promises';
 import {createRequire} from 'node:module';
 import pg from 'pg';import argon2 from 'argon2';
 import {databaseConfig} from './backend/dist/config.js';
 import {playableGbRom,playableGbaFlashRom} from './tests/helpers/play-roms.mjs';
 let input='';for await(const chunk of process.stdin)input+=chunk;
 const options=JSON.parse(input),hash=b=>createHash('sha256').update(b).digest('hex');
 if(options.seed){
  assert.match(process.env.PGDATABASE,/^emulador_states_test_[a-f0-9]{20}$/);
  const db=new pg.Client(databaseConfig());await db.connect();
  assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n,0);
  await db.query("INSERT INTO users(id,username,password_hash,role,must_change_password) VALUES($1,'states_ops',$2,'MASTER',false)",[randomUUID(),await argon2.hash(options.password)]);await db.end();
 }
 let cookie,csrf;
 async function request(path,method='GET',body){const headers={};if(cookie)headers.Cookie=cookie;
  if(method!=='GET'){headers.Origin='http://127.0.0.1:5173';headers['X-Requested-With']='XMLHttpRequest';if(csrf)headers['X-CSRF-Token']=csrf;
   if(!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body??{});}}
  const r=await fetch('http://127.0.0.1:3001/api'+path,{method,headers,body});assert.ok(r.ok,'API '+path+': '+r.status);return r.status===204?null:r;
 }
 const login=await request('/auth/login','POST',{username:'states_ops',password:options.password});cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrfToken;
 if(options.seed)for(const [name,rom] of [['GB',playableGbRom()],['GBA',playableGbaFlashRom()]]){const form=new FormData();form.append('name','State sintético '+name);form.append('active','true');form.append('rom',new Blob([rom]),'synthetic.'+(name==='GB'?'gb':'gba'));await request('/games','POST',form);}
 const factory=new Function('require','__dirname',(await readFile('frontend/public/emulator/mgba.js','utf8'))+';return createMgbaModule;')(createRequire(import.meta.url),process.cwd()+'/frontend/public/emulator');
 const wasm=await readFile('frontend/public/emulator/mgba.wasm');const coreId='wasm:'+hash(wasm);
 const games=(await(await request('/games')).json()).games;assert.equal(games.length,2);const result=[];
 for(const game of games){
  const lease=await(await request('/play/'+game.id+'/lease','POST')).json();
  const rom=game.console==='GB'?playableGbRom():playableGbaFlashRom();
  const m=await factory({wasmBinary:wasm,print:()=>{},printErr:()=>{}});
  const alloc=b=>{const p=m._malloc(b.length);m.HEAPU8.set(b,p);return p;};
  m._mgbawasm_init();m._mgbawasm_set_log_level(0);const rp=alloc(rom),model=alloc(new Uint8Array([68,77,71,0]));assert.equal(m._mgbawasm_load(rp,rom.length,0,0,game.console==='GB'?1:0,model,1),1);m._free(rp);m._free(model);
  const meta=await(await request('/play/'+game.id+'/states')).json();
  if(options.seed){
   m._mgbawasm_set_keys(1);for(let i=0;i<30;i++)m._mgbawasm_run_frame();m._mgbawasm_set_keys(0);
   const size=m._mgbawasm_state_size(),p=m._malloc(size);assert.equal(m._mgbawasm_state_save(p),1);const data=Buffer.from(m.HEAPU8.slice(p,p+size));m._free(p);
   const n=m._mgbawasm_sram_save(),native=Buffer.from(m.HEAPU8.slice(m._mgbawasm_sram_ptr(),m._mgbawasm_sram_ptr()+n));
   await request('/play/'+game.id+'/save','PUT',{leaseId:lease.leaseId,baseVersion:0,dataBase64:native.toString('base64'),sha256:hash(native)});
   for(const slot of [0,1])await request('/play/'+game.id+'/states/'+slot,'PUT',{leaseId:lease.leaseId,version:0,label:'Frame 30',coreId,romHash:meta.romHash,format:1,dataBase64:data.toString('base64'),nativeBase64:native.toString('base64'),sha256:hash(data),nativeSha256:hash(native)});
  }
  for(const slot of [0,1]){
   const {state}=await(await request('/play/'+game.id+'/states/'+slot+'/load','POST',{leaseId:lease.leaseId,version:1})).json();
   const native=Buffer.from(state.nativeBase64,'base64'),data=Buffer.from(state.dataBase64,'base64');assert.equal(hash(data),state.sha256);assert.equal(hash(native),state.nativeSha256);
   const np=alloc(native);assert.equal(m._mgbawasm_sram_load(np,native.length),1);m._free(np);const sp=alloc(data);assert.equal(m._mgbawasm_state_load(sp),1);m._free(sp);assert.equal(m._mgbawasm_frame_counter(),30);m._mgbawasm_run_frame();assert.equal(m._mgbawasm_frame_counter(),31);
   m._mgbawasm_sram_save();assert.equal(m.HEAPU8[m._mgbawasm_sram_ptr()],1);
   result.push({gameId:game.id,slot,sha256:state.sha256,nativeSha256:state.nativeSha256});
  }
  m._mgbawasm_unload();await request('/play/'+game.id+'/lease','DELETE',{leaseId:lease.leaseId});
 }
 if(options.expected)assert.deepEqual(result,options.expected);await request('/auth/logout','POST');process.stdout.write(JSON.stringify(result));
`;
const exerciseApi = async (container, options) => JSON.parse(await command('docker', ['exec', '-i', container, 'node', '--input-type=module', '-e', exercise], JSON.stringify({ password, ...options })));
try {
 const databaseContainer=await run(compose('ps','-q','database'));assert.ok(databaseContainer);
 await run(compose('exec','-T','--user','postgres','database','createdb','-U','postgres','--template=template0','--owner=emulador',database));ownsDatabase=true;
 await run(compose('run','--rm','--no-deps','-T','-e',`PGDATABASE=${database}`,'test-browser','node','backend/dist/database/migrate.js'),{quiet:true});
 await run(compose('run','--detach','--no-deps','--name',source,'-e',`PGDATABASE=${database}`,'test-browser','node','backend/dist/main.js'),{quiet:true});ownsSource=true;await ready(source);
 const expected=await exerciseApi(source,{seed:true});await run(['restart',source],{quiet:true});await ready(source);await exerciseApi(source,{expected});
 console.log('Core real GB/Flash128: quatro states e dois nativos persistidos; frame 30 restaurado após reiniciar API.');
 await mkdir('.local/backups',{recursive:true,mode:0o700});const manifest=await createCatalogueBackup({backendContainer:source,databaseContainer,outputPath:bundle});
 assert.equal(manifest.version,4);assert.equal(manifest.states.length,4);assert.equal(manifest.saves.length,2);await verifyCatalogueBackup(bundle);
 const output=await command(process.execPath,['scripts/restore-verify.mjs',bundle]);assert.match(output,/Estados restaurados e conferidos: 4/);assert.match(output,/Saves nativos restaurados e conferidos: 2/);
 console.log('Backup v4 restaurado em PostgreSQL isolado: quatro states e dois nativos com metadados/checksums íntegros.');console.log('Evidência sintética: '+bundle);
} finally {
 if(ownsSource)await run(['rm','--force',source],{quiet:true});
 if(ownsDatabase)await run(compose('exec','-T','--user','postgres','database','dropdb','-U','postgres','--force',database),{quiet:true});
}
