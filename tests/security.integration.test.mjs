import { verifiedMaster } from './helpers/verified-master.mjs';
import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import argon2 from 'argon2';
import { databaseConfig } from '../backend/dist/config.js';
import { migrate } from '../backend/dist/database/migrations.js';
import { createApp } from '../backend/dist/app.js';
import { RateLimitService } from '../backend/dist/auth/rate-limit.service.js';
import { Admission } from '../backend/dist/common/admission.js';
import { PasswordService } from '../backend/dist/auth/password.service.js';
import { normalizeIp, clientIp } from '../backend/dist/common/client-ip.js';
import { syntheticRom } from './helpers/catalog-fixtures.mjs';

const database = `emulador_security_${randomBytes(10).toString('hex')}`;
const original = { ...process.env };
const admin = new pg.Pool(databaseConfig());
const secret = randomBytes(24).toString('hex');
const origin = 'http://127.0.0.1:5173';
const key = text => createHash('sha256').update(text).digest('hex');
let pool, app, second, url, storage, owns = false, session;
async function start() { app = await createApp(); await app.listen(0, '127.0.0.1'); url = await app.getUrl(); }
function request(path, { ip = '127.0.0.2', body, method = body ? 'POST' : 'GET', headers = {}, target = url } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${target}${path}`, { method, localAddress: ip, headers: {
      Origin: origin, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json', ...headers,
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes,
          data: res.headers['content-type']?.includes('json') && bytes.length ? JSON.parse(bytes) : undefined });
      });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const login = async (username = 'missing', password = 'incorrect_password', options = {}) => { const result=await request('/api/auth/login', { body: { username, password }, ...options }); if(result.status===200)await verifiedMaster(pool,result.data.user,result.headers['set-cookie'][0].split(';')[0]);return result; };
const history = async (ip = '127.0.0.2') => (await pool.query('SELECT * FROM login_attempts WHERE key=$1', [key(`login-failures:${ip}`)])).rows[0];
const authHeaders = () => ({ Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken });

before(async () => {
  await admin.query(`CREATE DATABASE "${database}"`); owns = true;
  storage = await mkdtemp(join(tmpdir(), 'emulador-security-'));
  process.env.PGDATABASE = database; process.env.APP_ORIGIN = origin; process.env.CATALOG_STORAGE_DIR = storage;
  delete process.env.TRUSTED_PROXY_HOST;
  pool = new pg.Pool(databaseConfig()); await migrate(pool);
  const hash = await argon2.hash(secret);
  await pool.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,'security_master',$2,'MASTER')", [randomUUID(), hash]);
  await start();
  const result = await login('security_master', secret);
  assert.equal(result.status, 200);
  session = { cookie: result.headers['set-cookie'][0].split(';')[0], csrfToken: result.data.csrfToken };
});
beforeEach(async () => { await app.close(); await pool.query('DELETE FROM login_attempts'); await start(); });
after(async () => {
  await second?.close(); await app?.close(); await pool?.end();
  if (owns) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end(); if (storage) await rm(storage, { recursive: true, force: true });
  for (const name of ['PGDATABASE','APP_ORIGIN','CATALOG_STORAGE_DIR','TRUSTED_PROXY_HOST']) {
    if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
  }
});

test('terceira falha entre nomes bloqueia por 7200s; acertos e outros IPs preservam o histórico', async () => {
  assert.equal((await login('missing_one')).status, 401);
  assert.equal((await login('security_master', secret)).status, 200);
  assert.equal((await login('missing_other', undefined, { ip: '127.0.0.3' })).status, 401);
  assert.equal((await login('missing_two')).status, 401);
  const third = await login('security_master');
  assert.equal(third.status, 429); assert.equal(third.headers['retry-after'], '7200');
  assert.match(third.data.message, /Login temporariamente bloqueado.*IP/);
  const record = await history(); assert.equal(record.failure_times.length, 3);
  const last = record.failure_times[2];
  assert.ok(Math.abs(record.blocked_until - last - 7200000) < 10);
  assert.equal((await login('security_master', secret)).status, 429);
  assert.equal((await history()).blocked_until.getTime(), record.blocked_until.getTime());
  assert.equal((await login('security_master', secret, { ip: '127.0.0.3' })).status, 200);
  assert.equal((await history('127.0.0.3')).failure_times.length, 1);
  assert.equal((await request('/api/auth/me', { headers: authHeaders() })).status, 200);
});

test('janela móvel descarta apenas falhas vencidas; bloqueio expirado inicia contagem nova', async () => {
  await login(); await login('missing_two');
  await pool.query("UPDATE login_attempts SET failure_times=ARRAY[clock_timestamp()-interval '2 hours 1 second',clock_timestamp()-interval '1 hour'] WHERE key=$1", [key('login-failures:127.0.0.2')]);
  assert.equal((await login('missing_three')).status, 401);
  assert.equal((await history()).failure_times.length, 2);
  assert.equal((await login('missing_four')).status, 429);
  await pool.query("UPDATE login_attempts SET blocked_until=clock_timestamp()-interval '1 second' WHERE key=$1", [key('login-failures:127.0.0.2')]);
  assert.equal((await login('missing_five')).status, 401);
  assert.equal((await history()).failure_times.length, 1);
});

test('rajada concorrente entre duas APIs não verifica mais senhas após a terceira falha', async () => {
  await login(); await login('missing_two');
  second = await createApp(); await second.listen(0, '127.0.0.1');
  const secondUrl = await second.getUrl();
  let verifications = 0;
  for (const instance of [app, second]) {
    const service = instance.get(PasswordService), verify = service.verify.bind(service);
    service.verify = (...args) => { verifications++; return verify(...args); };
  }
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => login(`parallel_${i}`, undefined, { target: i % 2 ? url : secondUrl })));
  assert.ok(results.every(result => result.status === 429));
  assert.equal(verifications, 1);
  assert.equal((await history()).failure_times.length, 3);
  await second.close(); second = undefined;
  await app.close(); await start();
  const result = await login('security_master', secret);
  assert.equal(result.status, 429);
  assert.ok(Number(result.headers['retry-after']) > 7100);
  assert.equal((await request('/api/auth/me', { headers: authHeaders() })).status, 200);
});

test('cabeçalhos forjados não mudam IP direto; IPv4 mapeado e IPv6 são canônicos', async () => {
  for (let i = 0; i < 3; i++) {
    const result = await login(`spoof_${i}`, undefined, { headers: { 'X-Forwarded-For': `203.0.113.${i + 1}`, Forwarded: 'for=198.51.100.1', 'X-Real-IP': '192.0.2.1' } });
    assert.equal(result.status, i === 2 ? 429 : 401);
  }
  assert.equal((await history()).failure_times.length, 3);
  assert.equal((await login('security_master', secret, { ip: '127.0.0.4' })).status, 200);
  assert.equal(normalizeIp('::ffff:127.0.0.2'), '127.0.0.2');
  assert.equal(normalizeIp('::ffff:7f00:2'), '127.0.0.2');
  assert.equal(normalizeIp('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  for (const ip of ['1.2.3.4, 5.6.7.8', 'garbage', 'fe80::1%eth0']) assert.throws(() => normalizeIp(ip));
  const fake = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded } });
  assert.equal(await clientIp(fake('127.0.0.1','203.0.113.9'), 'localhost'), '203.0.113.9');
  assert.equal(await clientIp(fake('127.0.0.2','203.0.113.9'), 'localhost'), '127.0.0.2');
  await assert.rejects(clientIp(fake('127.0.0.1','203.0.113.9, 1.2.3.4'), 'localhost'));
});

test('SEC-01: pressão distribuída exige desafio, nunca bloqueia conta ou troca autenticada', async () => {
  for(let i=0;i<10;i++) assert.ok([401,429].includes((await login('security_master','wrong',{ip:`127.0.1.${i+1}`})).status));
  const challenge=await login('security_master',secret,{ip:'127.0.2.1'});
  assert.equal(challenge.status,428);assert.equal(challenge.data.challenge.zeros,4);
  const {token,zeros}=challenge.data.challenge;let nonce=0;
  while(!key(`${token}:${nonce}`).startsWith('0'.repeat(zeros))) nonce++;
  const solved={username:'security_master',password:secret,proofToken:token,proofNonce:String(nonce)};
  assert.equal((await request('/api/auth/login',{ip:'127.0.2.2',body:solved})).status,428); // bound to IP
  const accepted=await request('/api/auth/login',{ip:'127.0.2.1',body:solved});assert.equal(accepted.status,200);
  assert.equal((await request('/api/auth/login',{ip:'127.0.2.1',body:solved})).status,428); // one use
  const missing='unknown_account';
  for(let i=0;i<10;i++) await login(missing,'wrong',{ip:`127.0.3.${i+1}`});
  assert.equal((await login(missing,'wrong',{ip:'127.0.3.20'})).status,428);
  await pool.query("UPDATE login_attempts SET window_start=clock_timestamp()-interval '16 minutes' WHERE key=$1",[key('login-pressure:security_master')]);
  assert.equal((await login('security_master',secret,{ip:'127.0.2.3'})).status,200);
  const changed=await request('/api/auth/password',{headers:authHeaders(),body:{currentPassword:secret,newPassword:secret+'_new'}});
  assert.equal(changed.status,204);
  // Test-only restoration in disposable database; recreate a session for subsequent cases.
  await pool.query('UPDATE users SET password_hash=$1',[await argon2.hash(secret)]);
  const result=await login('security_master',secret,{ip:'127.0.2.4'});
  session={cookie:result.headers['set-cookie'][0].split(';')[0],csrfToken:result.data.csrfToken};
});

test('SEC-02: admissão anônima sem writes, memória/fila limitadas e limpeza sem login', async () => {
  await pool.query("INSERT INTO login_attempts(key,attempts,window_start,expires_at) VALUES($1,1,now()-interval '3 days',now()-interval '1 day')",[key('expired')]);
  await pool.query("INSERT INTO login_attempts(key,attempts,window_start,expires_at,blocked_until) VALUES($1,1,now(),now()-interval '1 day',now()+interval '1 hour')",[key('active-block')]);
  for(let i=0;i<40;i++) assert.equal((await request('/api/not-found',{ip:`127.0.4.${i+1}`})).status,404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM login_attempts')).rows[0].n,2);
  await app.get(RateLimitService).cleanup();
  assert.equal((await pool.query('SELECT key FROM login_attempts')).rows[0].key,key('active-block'));
  let now=0;const admission=new Admission(()=>now,8);
  for(let i=0;i<8;i++)admission.take(String(i),1,1000);
  assert.throws(()=>admission.take('ninth',1,1000));assert.equal(admission.entries.size,8);
  now=1001;admission.take('new',1,1000);assert.equal(admission.entries.size,1);
  const releases=[admission.enter(true),admission.enter(true)];assert.throws(()=>admission.enter(true));
  for(let i=0;i<30;i++)releases.push(admission.enter(false));assert.throws(()=>admission.enter(false));
  releases.forEach(release=>{release();release();});assert.equal(admission.active,0);
  // Exact database cardinality cap; authenticated buckets retain reserved capacity.
  await pool.query("INSERT INTO login_attempts(key,attempts,window_start) SELECT md5(i::text)||md5(i::text),1,now() FROM generate_series(1,8999) AS i");
  await assert.rejects(app.get(RateLimitService).ensure(key('overflow'),60));
  await app.get(RateLimitService).bucket('password-actor','synthetic',5,900);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM login_attempts')).rows[0].n,9001);
});

test('SEC-02: rajada por rota rejeitada antes do banco e sem hash', async () => {
  for(let i=0;i<30;i++)assert.equal((await request('/api/auth/login',{body:{username:'bad name',password:secret}})).status,400);
  const denied=await login('security_master',secret);assert.equal(denied.status,429);assert.ok(denied.headers['retry-after']);
  assert.equal(await history(),undefined);
  assert.equal((await request('/api/auth/me',{headers:authHeaders()})).status,200);
});

test('payloads SQL são dados; sessão, ROM, heartbeat e save funcionam durante bloqueio de login', async () => {
  const payload = "x'); DROP TABLE users; --";
  assert.equal((await login("' OR 1=1 --", secret)).status, 400);
  assert.equal((await login('security_master', payload)).status, 401);
  const form = new FormData(); form.set('name', payload); form.set('active','true');
  const rom = syntheticRom(); form.set('rom', new Blob([rom]), 'synthetic.gb');
  const created = await fetch(`${url}/api/games`, { method:'POST', headers: { ...authHeaders(), Origin:origin, 'X-Requested-With':'XMLHttpRequest' }, body:form });
  assert.equal(created.status,201); const { game } = await created.json(); assert.equal(game.name,payload);
  await login('missing_second'); assert.equal((await login('missing_third')).status,429);
  assert.equal((await request('/api/games?sort='+encodeURIComponent(payload), { headers:authHeaders() })).data.games[0].name,payload);
  assert.equal((await request('/api/users?filter='+encodeURIComponent(payload), { headers:authHeaders() })).status,200);
  for (const path of ['/api/users/','/api/play/','/api/games/']) {
    const result = await request(path+encodeURIComponent(payload), { headers:authHeaders() });
    assert.ok([400,404].includes(result.status)); assert.doesNotMatch(JSON.stringify(result.data), /SELECT|stack|syntax error/i);
  }
  assert.equal((await request('/api/users', { headers:authHeaders(), body:{username:payload,password:secret} })).status,400);
  const base = `/api/play/${game.id}`;
  const downloaded = await request(`${base}/rom`, { headers:authHeaders() }); assert.deepEqual(downloaded.bytes,rom);
  const lease = await request(`${base}/lease`, { headers:authHeaders(),body:{} }); assert.equal(lease.status,201);
  const leaseId = lease.data.leaseId;
  assert.equal((await request(`${base}/lease/renew`, { method:'POST',headers:authHeaders(),body:{leaseId} })).status,200);
  const bytes = Buffer.from(payload), sha256 = key(payload);
  const saved = await request(`${base}/save`, { method:'PUT',headers:authHeaders(),body:{leaseId,baseVersion:0,dataBase64:bytes.toString('base64'),sha256} });
  assert.equal(saved.status,200);
  assert.equal((await request(`${base}/save`, { method:'PUT',headers:authHeaders(),body:{leaseId:payload,baseVersion:1,dataBase64:bytes.toString('base64'),sha256} })).status,400);
  const stored = await pool.query('SELECT data,version FROM game_saves WHERE game_id=$1',[game.id]);
  assert.deepEqual(stored.rows[0].data,bytes); assert.equal(stored.rows[0].version,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,1);
});

test('SEC-02: desconexão não libera vaga enquanto verificação ainda está em execução',async()=>{
 const {PasswordService}=await import('../backend/dist/auth/password.service.js');const service=app.get(PasswordService),originalVerify=service.verify.bind(service);
 let finish,entered=0,completed=0;const gate=new Promise(resolve=>{finish=resolve;});
 service.verify=async(...args)=>{entered++;await gate;try{return await originalVerify(...args);}finally{completed++;}};
 const open=ip=>{const target=new URL('/api/auth/login',url);const req=httpRequest(target,{method:'POST',localAddress:ip,headers:{Origin:origin,'X-Requested-With':'XMLHttpRequest','Content-Type':'application/json'}},res=>res.resume());req.on('error',()=>{});req.end(JSON.stringify({username:`missing_${ip.replaceAll('.','_')}`,password:'wrong'}));return req;};
 const a=open('127.0.8.1'),b=open('127.0.8.2');
 try{
  const deadline=Date.now()+3000;while(entered<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.equal(entered,2);
  a.destroy();b.destroy();await new Promise(r=>setTimeout(r,30));
  assert.equal((await login('missing','wrong',{ip:'127.0.8.3'})).status,429);assert.equal(entered,2);
 }finally{finish();service.verify=originalVerify;}
 const settled=Date.now()+5000;while(completed<2&&Date.now()<settled)await new Promise(r=>setTimeout(r,10));assert.equal(completed,2);assert.equal((await login('missing','wrong',{ip:'127.0.8.4'})).status,401);
});

test('SEC-02: limpeza periódica remove vencidos sem login e preserva bloqueio ativo',{timeout:70000},async()=>{
 const expired=key('periodic-expired'),blocked=key('periodic-blocked');
 await pool.query("INSERT INTO login_attempts(key,attempts,window_start,expires_at,blocked_until) VALUES($1,1,now(),now()-interval '1 minute',NULL),($2,1,now(),now()-interval '1 minute',now()+interval '1 hour')",[expired,blocked]);
 const deadline=Date.now()+65000;let present=true;
 while(present&&Date.now()<deadline){await new Promise(r=>setTimeout(r,250));present=!!(await pool.query('SELECT 1 FROM login_attempts WHERE key=$1',[expired])).rowCount;}
 assert.equal(present,false);assert.equal((await pool.query('SELECT 1 FROM login_attempts WHERE key=$1',[blocked])).rowCount,1);
});
