import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import argon2 from 'argon2';
import { databaseConfig } from '../backend/dist/config.js';
import { migrate } from '../backend/dist/database/migrations.js';
import { createApp } from '../backend/dist/app.js';
import { STATE_CORE } from '../backend/dist/play/states.service.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const upgrade of [false,true])test(`SEC-08: ${upgrade?'upgrade 001–006 preserva dados':'instalação nova'} e API com papel runtime`,{skip: !process.env.TEST_OWNER_PASSWORD || !process.env.TEST_RUNTIME_PASSWORD ? 'Exige cluster descartável provisionado com migrador/runtime e senhas sintéticas próprias.' : false},async()=>{
 const admin=new pg.Pool(databaseConfig()),database=`runtime_${randomBytes(6).toString('hex')}`;
 let owner,runtime,app,created=false;const directory=await mkdtemp(join(tmpdir(),'runtime-'));
 const original={...process.env},password='synthetic-runtime-password',uid=randomUUID(),gid=randomUUID();
 const native=Buffer.alloc(8192,7),state=Buffer.alloc(71680,9),romHash='a'.repeat(64);
 try{
  await admin.query(`CREATE DATABASE "${database}" OWNER emulador`);created=true;
  owner=new pg.Pool({...databaseConfig(),database,user:'emulador',password:process.env.TEST_OWNER_PASSWORD});
  if(upgrade){
   await owner.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
   for(const name of (await readdir('backend/migrations')).filter(n=>/^00[1-6]-.*\.sql$/.test(n)).sort()){
    const sql=await readFile(join('backend/migrations',name),'utf8');await owner.query(sql);await owner.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,hash(sql)]);
   }
  }else await migrate(owner);
  await owner.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,'runtime_player',$2,'JOGADOR')",[uid,await argon2.hash(password)]);
  await owner.query("INSERT INTO games(id,name,active,rom_key,rom_sha256,rom_size,cartridge_type,cgb_flag,console) VALUES($1,'Synthetic',true,$2,$3,32768,3,0,'GB')",[gid,`${gid}.gb`,romHash]);
  await owner.query('INSERT INTO game_saves(user_id,game_id,data,sha256,size,version) VALUES($1,$2,$3,$4,$5,4)',[uid,gid,native,hash(native),native.length]);
  await owner.query("INSERT INTO save_states(user_id,game_id,slot,version,console,rom_sha256,core_id,format,data,native,sha256,native_sha256) VALUES($1,$2,0,3,'GB',$3,$4,1,$5,$6,$7,$8)",[uid,gid,romHash,STATE_CORE,state,native,hash(state),hash(native)]);
  const before=(await owner.query('SELECT sha256,version FROM game_saves UNION ALL SELECT sha256,version FROM save_states ORDER BY version')).rows;
  await migrate(owner);await migrate(owner);
  assert.deepEqual((await owner.query('SELECT sha256,version FROM game_saves UNION ALL SELECT sha256,version FROM save_states ORDER BY version')).rows,before);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,10);
  // Provisioning also revokes TEMP on this restored/new database.
  await owner.query('REVOKE TEMP ON DATABASE "'+database+'" FROM PUBLIC');
  runtime=new pg.Pool({...databaseConfig(),database,user:'emulador_runtime',password:process.env.TEST_RUNTIME_PASSWORD});
  for(const sql of ['CREATE TABLE forbidden(id int)','ALTER TABLE users ADD COLUMN forbidden int','TRUNCATE users CASCADE','DELETE FROM schema_migrations','CREATE TEMP TABLE forbidden(id int)','SET ROLE emulador','CREATE ROLE forbidden'])await assert.rejects(runtime.query(sql),e=>e.code==='42501');
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM game_saves')).rows[0].n,1);
  process.env.PGDATABASE=database;process.env.PGUSER='emulador_runtime';process.env.PGPASSWORD=process.env.TEST_RUNTIME_PASSWORD;delete process.env.PGPASSWORD_FILE;
  process.env.CATALOG_STORAGE_DIR=directory;process.env.APP_ORIGIN='http://127.0.0.1:5173';delete process.env.TRUSTED_PROXY_HOST;
  app=await createApp();await app.listen(0,'127.0.0.1');const url=await app.getUrl();let cookie,csrf;
  async function request(path,method='GET',body){const r=await fetch(url+path,{method,headers:{Origin:process.env.APP_ORIGIN,'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest',...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,headers:r.headers,data:await r.json()};}
  const login=await request('/api/auth/login','POST',{username:'runtime_player',password});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.data.csrfToken;
  assert.equal((await request('/api/auth/me')).status,200);
  const lease=await request(`/api/play/${gid}/lease`,'POST',{});assert.equal(lease.status,201,JSON.stringify(lease.data));
  const loaded=await request(`/api/play/${gid}/states/0/load`,'POST',{leaseId:lease.data.leaseId,version:3});assert.equal(loaded.status,201,loaded.data.message);assert.equal(loaded.data.state.sha256,hash(state));
  const saved=await request(`/api/play/${gid}/save`,'PUT',{leaseId:lease.data.leaseId,baseVersion:4,dataBase64:native.toString('base64'),sha256:hash(native)});assert.equal(saved.status,200,JSON.stringify(saved.data));
 }finally{await app?.close();await runtime?.end();await owner?.end();if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();await rm(directory,{recursive:true,force:true});for(const key of ['PGDATABASE','PGUSER','PGPASSWORD','PGPASSWORD_FILE','CATALOG_STORAGE_DIR','APP_ORIGIN','TRUSTED_PROXY_HOST']){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}}
});
