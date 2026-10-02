import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { databaseConfig } from '../backend/dist/config.js';
import { migrate } from '../backend/dist/database/migrations.js';
import { createApp } from '../backend/dist/app.js';
import { RateLimitService } from '../backend/dist/auth/rate-limit.service.js';
import { DatabaseService } from '../backend/dist/database/database.service.js';
import { csrfForToken } from '../backend/dist/auth/session.js';
import { STATE_CORE } from '../backend/dist/play/states.service.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const globalKey = hash('states-ingress-global:global'), actorKey = actor => hash(`states-ingress:${actor.id}`);
const origin = 'http://127.0.0.1:5173', database = `emulador_ingress_${randomBytes(8).toString('hex')}`;
const original = {...process.env}, admin = new pg.Pool(databaseConfig());
let pool, directory, owned = false;
const apps = [], urls = [], actors = [];
const game = randomUUID(), romHash = 'a'.repeat(64);
function request(instance, actor, body = {}, path = `/api/play/${game}/states/0`, method = 'PUT') {
 return new Promise((resolve,reject) => {
  const req=httpRequest(new URL(path,urls[instance]),{method,localAddress:actor.ip,headers:{Origin:origin,'X-Requested-With':'XMLHttpRequest','Content-Type':'application/json',Cookie:`emulador_session=${actor.token}`,'X-CSRF-Token':csrfForToken(actor.token)}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,data:text?JSON.parse(text):null});});
  });req.on('error',reject);req.end(JSON.stringify(body));
 });
}
async function counters() {return (await pool.query('SELECT key,attempts,window_start,expires_at FROM login_attempts ORDER BY key')).rows;}
before(async()=>{
 await admin.query(`CREATE DATABASE "${database}"`);owned=true;
 directory=await mkdtemp(join(tmpdir(),'emulador-ingress-'));process.env.PGDATABASE=database;process.env.CATALOG_STORAGE_DIR=directory;process.env.APP_ORIGIN=origin;delete process.env.TRUSTED_PROXY_HOST;
 pool=new pg.Pool(databaseConfig());await migrate(pool);
 for(let i=0;i<8;i++){
  const actor={id:randomUUID(),token:randomBytes(32).toString('base64url'),ip:`127.0.4.${i+1}`};actors.push(actor);
  await pool.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'synthetic-unused-hash','JOGADOR')",[actor.id,`ingress_${i}`]);
  await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hash(actor.token),actor.id]);
 }
 await pool.query("INSERT INTO games(id,name,active,rom_key,rom_sha256,rom_size,cartridge_type,cgb_flag,console) VALUES($1,'Synthetic ingress',true,$2,$3,32768,3,0,'GB')",[game,`${game}.gb`,romHash]);
 for(let i=0;i<2;i++){const app=await createApp();apps.push(app);await app.listen(0,'127.0.0.1');urls.push(await app.getUrl());}
});
beforeEach(async()=>{await pool.query('DELETE FROM login_attempts');});
after(async()=>{
 for(const app of apps)await app.close();await pool?.end();if(owned)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();if(directory)await rm(directory,{recursive:true,force:true});
 for(const key of ['PGDATABASE','CATALOG_STORAGE_DIR','APP_ORIGIN','TRUSTED_PROXY_HOST']){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
});

test('RECHECK-01: excesso de A não cobra global; B de outro IP valida e grava',async()=>{
 const [a,b]=actors;
 for(let i=0;i<20;i++)assert.equal((await request(i%2,a)).status,400);
 const before=await counters();
 for(let i=0;i<100;i++){const r=await request(i%2,a);assert.equal(r.status,429);assert.ok(Number(r.headers['retry-after'])>=1&&Number(r.headers['retry-after'])<=60);}
 assert.deepEqual(await counters(),before);
 assert.equal((await request(1,b)).status,400);
 const lease=await request(1,b,{},`/api/play/${game}/lease`,'POST');assert.equal(lease.status,201,JSON.stringify(lease.data));
 const data=Buffer.alloc(71680,13),native=Buffer.from('synthetic cartridge');
 const body={leaseId:lease.data.leaseId,version:0,label:'Synthetic',coreId:STATE_CORE,romHash,format:1,dataBase64:data.toString('base64'),nativeBase64:native.toString('base64'),sha256:hash(data),nativeSha256:hash(native)};
 assert.equal((await request(1,b,body)).status,200);
 assert.equal((await request(0,b,body)).status,200); // lost ACK retry still passes ingress
 assert.equal((await pool.query('SELECT version FROM save_states WHERE user_id=$1',[b.id])).rows[0].version,1);
 assert.equal((await pool.query('SELECT attempts FROM login_attempts WHERE key=$1',[globalKey])).rows[0].attempts,23);
});

test('RECHECK-01: global cheio não cobra ator; expiração e Retry-After coerentes',async()=>{
 const a=actors[0];assert.equal((await request(0,a)).status,400);
 await pool.query("UPDATE login_attempts SET attempts=120,window_start=clock_timestamp()-interval '40 seconds' WHERE key=$1",[globalKey]);
 const before=await counters(),denied=await request(1,a);assert.equal(denied.status,429);assert.ok(Number(denied.headers['retry-after'])>=18&&Number(denied.headers['retry-after'])<=20);
 assert.deepEqual(await counters(),before);
 await pool.query("UPDATE login_attempts SET window_start=clock_timestamp()-interval '61 seconds' WHERE key=$1",[globalKey]);
 assert.equal((await request(1,a)).status,400);
 await pool.query("UPDATE login_attempts SET attempts=20 WHERE key=$1",[actorKey(a)]);
 const beforeActor=await counters();assert.equal((await request(0,a)).status,429);assert.deepEqual(await counters(),beforeActor);
 await pool.query("UPDATE login_attempts SET window_start=clock_timestamp()-interval '61 seconds' WHERE key=$1",[actorKey(a)]);
 assert.equal((await request(0,a)).status,400);
 assert.equal((await pool.query('SELECT attempts FROM login_attempts WHERE key=$1',[actorKey(a)])).rows[0].attempts,1);
});

test('RECHECK-01: duas APIs, primeira utilização concorrente, limites exatos e sem cobrança parcial',async()=>{
 // Controlled waves stay within parser concurrency, while sharing DB admission.
 const statuses=[];
 for(let i=0;i<20;i++)statuses.push(...await Promise.all([request(0,actors[0]),request(1,actors[0])]).then(rs=>rs.map(r=>r.status)));
 assert.equal(statuses.filter(s=>s===400).length,20);assert.equal(statuses.filter(s=>s===429).length,20);
 assert.equal((await pool.query('SELECT attempts FROM login_attempts WHERE key=$1',[globalKey])).rows[0].attempts,20);
 // Six more actors race through both APIs: global, rather than per-actor, exhausts.
 let admitted=20;
 for(let i=0;i<60;i++){
  const pair=await Promise.all([request(0,actors[1+i%6]),request(1,actors[1+(i+3)%6])]);
  assert.ok(pair.every(r=>[400,429].includes(r.status)));admitted+=pair.filter(r=>r.status===400).length;
 }
 assert.equal(admitted,120);
 const rows=await counters();assert.equal(rows.find(r=>r.key===globalKey).attempts,120);
 assert.equal(rows.filter(r=>r.key!==globalKey).reduce((sum,r)=>sum+r.attempts,0),120);
 const before=await counters();assert.equal((await request(1,actors[1])).status,429);assert.deepEqual(await counters(),before);
});

test('RECHECK-01: cleanup entre preparo e lock recusa sem débito e permite nova tentativa',async()=>{
 const service=apps[0].get(RateLimitService),ensure=service.ensure.bind(service);let calls=0;
 service.ensure=async(...args)=>{await ensure(...args);if(++calls===2){await pool.query("UPDATE login_attempts SET expires_at=clock_timestamp()-interval '1 second'");await apps[1].get(RateLimitService).cleanup();}};
 try{const r=await request(0,actors[0]);assert.equal(r.status,429);assert.equal(r.headers['retry-after'],'1');assert.equal((await counters()).length,0);}
 finally{service.ensure=ensure;}
 assert.equal((await request(0,actors[0])).status,400);
 // Existing expired windows, concurrent periodic cleanup and two first users.
 await pool.query("UPDATE login_attempts SET expires_at=clock_timestamp()-interval '1 second',window_start=clock_timestamp()-interval '61 seconds'");
 const results=await Promise.all([request(0,actors[0]),request(1,actors[1]),apps[1].get(RateLimitService).cleanup()]);
 assert.ok(results.slice(0,2).every(r=>[400,429].includes(r.status)));
 const rows=await counters(),accepted=results.slice(0,2).filter(r=>r.status===400).length;
 if(accepted)assert.equal(rows.find(r=>r.key===globalKey).attempts,accepted);
});

test('RECHECK-01: capacidade/indisponibilidade recusam sem bypass ou cobrança parcial',async()=>{
 const a=actors[0];assert.equal((await request(0,a)).status,400);
 await pool.query("INSERT INTO login_attempts(key,attempts,window_start,scope) SELECT md5(i::text)||md5(i::text),1,now(),'actor' FROM generate_series(1,997) AS i");
 const raced=await Promise.all([request(0,actors[2]),request(1,actors[3])]);
 assert.deepEqual(raced.map(r=>r.status).sort(),[400,429]);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM login_attempts WHERE scope='actor'")).rows[0].n,1000);
 const before=(await pool.query('SELECT attempts FROM login_attempts WHERE key=$1',[globalKey])).rows[0].attempts;
 assert.equal((await request(1,actors[1])).status,429);
 assert.equal((await pool.query('SELECT attempts FROM login_attempts WHERE key=$1',[globalKey])).rows[0].attempts,before);
 // A transaction error after the first debit must roll back both, not admit body.
 const db=apps[0].get(DatabaseService),transaction=db.transaction.bind(db);
 db.transaction=work=>transaction(async client=>{await work(client);throw new Error('synthetic transaction failure');});
 try{assert.equal((await request(0,a)).status,500);}finally{db.transaction=transaction;}
 assert.equal((await pool.query('SELECT attempts FROM login_attempts WHERE key=$1',[globalKey])).rows[0].attempts,before);
});

test('RECHECK-01: corpo incompleto não mantém transação/travas; abandono não reembolsa',async()=>{
 const actor=actors[0];
 const req=httpRequest(new URL(`/api/play/${game}/states/0`,urls[0]),{method:'PUT',localAddress:actor.ip,headers:{Origin:origin,'X-Requested-With':'XMLHttpRequest','Content-Type':'application/json','Content-Length':'2',Cookie:`emulador_session=${actor.token}`,'X-CSRF-Token':csrfForToken(actor.token)}});
 req.on('error',()=>{});req.write('{');
 const client=await pool.connect();
 try{
  const until=Date.now()+3000;let charged=false;
  while(Date.now()<until){charged=(await pool.query('SELECT attempts FROM login_attempts WHERE key=$1',[globalKey])).rows[0]?.attempts===1;if(charged)break;await new Promise(r=>setTimeout(r,10));}
  assert.ok(charged,'admission must commit before the body finishes');
  await client.query('BEGIN');
  assert.equal((await client.query('SELECT key FROM login_attempts WHERE key=ANY($1::text[]) FOR UPDATE NOWAIT',[[globalKey,actorKey(actor)]])).rowCount,2);
  await client.query('ROLLBACK');
  assert.equal((await request(1,actors[1])).status,400);
 }finally{await client.query('ROLLBACK');client.release();req.destroy();}
 assert.equal((await pool.query('SELECT attempts FROM login_attempts WHERE key=$1',[globalKey])).rows[0].attempts,2);
});
