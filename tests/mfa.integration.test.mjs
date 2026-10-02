import assert from 'node:assert/strict';
import { before,after,test } from 'node:test';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import argon2 from 'argon2';
import { generate } from 'otplib';
import { databaseConfig } from '../backend/dist/config.js';
import { migrate } from '../backend/dist/database/migrations.js';
import { createApp } from '../backend/dist/app.js';
import { AuditService } from '../backend/dist/common/audit.service.js';
const database=`emulador_mfa_${randomBytes(8).toString('hex')}`,admin=new pg.Pool(databaseConfig());
const origin='http://127.0.0.1:5173',password=randomBytes(24).toString('base64url'),original={...process.env};
let pool,app,url,dir,hash,owns=false;
const hashToken=s=>createHash('sha256').update(s).digest('hex');
async function request(path,body,session){const response=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'X-Requested-With':'XMLHttpRequest','Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrfToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await response.text();return {status:response.status,data:text?JSON.parse(text):null,headers:response.headers};}
const session=r=>({cookie:r.headers.get('set-cookie').split(';')[0],csrfToken:r.data.csrfToken});
async function user(role='MASTER'){const id=randomUUID(),username=`mfa_${randomBytes(5).toString('hex')}`;await pool.query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',[id,username,hash,role]);return {id,username};}
async function login(u){const r=await request('/api/auth/login',{username:u.username,password});assert.equal(r.status,200);return {...session(r),mfa:r.data.mfa};}
async function enrolled(){const u=await user(),pending=await login(u);const start=await request('/api/auth/mfa/enroll',{password},pending);assert.equal(start.status,200,JSON.stringify(start.data));const secret=start.data.secret;const code=await generate({secret});const confirmed=await request('/api/auth/mfa/confirm',{code},pending);assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));return {u,secret,code,verified:session(confirmed),codes:confirmed.data.recoveryCodes};}
before(async()=>{await admin.query(`CREATE DATABASE "${database}"`);owns=true;dir=await mkdtemp(join(tmpdir(),'emulador-mfa-'));const key=join(dir,'key');await writeFile(key,randomBytes(32).toString('hex'),{mode:0o600});process.env.MFA_ENCRYPTION_KEY_FILE=key;process.env.PGDATABASE=database;process.env.APP_ORIGIN=origin;process.env.CATALOG_STORAGE_DIR=join(dir,'catalog');delete process.env.TRUSTED_PROXY_HOST;pool=new pg.Pool(databaseConfig());await migrate(pool);hash=await argon2.hash(password);app=await createApp();await app.listen(0,'127.0.0.1');url=await app.getUrl();});
after(async()=>{await app?.close();await pool?.end();if(owns)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();if(dir)await rm(dir,{recursive:true,force:true});for(const k of ['MFA_ENCRYPTION_KEY_FILE','PGDATABASE','APP_ORIGIN','CATALOG_STORAGE_DIR','TRUSTED_PROXY_HOST']){if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];}});

test('SEC-05: cadastro confirmado, segredo cifrado, sessão limitada e recuperação única concorrente',async()=>{
 const u=await user(),pending=await login(u);assert.equal(pending.mfa,'enroll');
 assert.equal((await request('/api/users',undefined,pending)).status,403);assert.equal((await request('/api/games',undefined,pending)).status,403);
 assert.equal((await request('/api/auth/mfa/enroll',{password:'wrong'},pending)).status,400);
 const start=await request('/api/auth/mfa/enroll',{password},pending);assert.equal(start.status,200);const secret=start.data.secret;
 assert.ok(start.data.uri.startsWith('otpauth://totp/'));assert.match(secret,/^[A-Z2-7]+$/);
 const stored=(await pool.query('SELECT * FROM users WHERE id=$1',[u.id])).rows[0];assert.equal(stored.mfa_secret,null);assert.ok(!stored.mfa_pending_secret.includes(secret));
 const otherPending=await login(u);assert.equal((await request('/api/auth/mfa/confirm',{code:await generate({secret})},otherPending)).status,400);
 const result=await request('/api/auth/mfa/confirm',{code:await generate({secret})},pending);assert.equal(result.status,200);const verified=session(result);
 assert.equal(result.data.recoveryCodes.length,10);assert.equal(new Set(result.data.recoveryCodes).size,10);
 assert.equal((await request('/api/auth/me',undefined,pending)).status,401);assert.equal((await request('/api/users',undefined,verified)).status,200);
 const encrypted=(await pool.query('SELECT mfa_secret,mfa_recovery_hashes FROM users WHERE id=$1',[u.id])).rows[0];assert.ok(!JSON.stringify(encrypted).includes(secret));assert.ok(!JSON.stringify(encrypted).includes(result.data.recoveryCodes[0]));
 const a=await login(u),b=await login(u);assert.equal(a.mfa,'verify');
 const replay=await request('/api/auth/mfa/verify',{code:await generate({secret})},a);assert.equal(replay.status,400);
 const attempts=await Promise.all([request('/api/auth/mfa/verify',{code:result.data.recoveryCodes[0]},a),request('/api/auth/mfa/verify',{code:result.data.recoveryCodes[0]},b)]);
 assert.equal(attempts.filter(r=>r.status===200).length,1);assert.ok(attempts.every(r=>[200,400,401].includes(r.status)));
 assert.equal((await request('/api/auth/me',undefined,verified)).status,401);
 const after=(await pool.query('SELECT mfa_recovery_hashes FROM users WHERE id=$1',[u.id])).rows[0];assert.equal(after.mfa_recovery_hashes.length,9);
});

test('SEC-05: reautenticação usa senha+MFA; TTL, inatividade, CSRF e revogação',async()=>{
 const {u,verified,codes,secret}=await enrolled();
 const token=verified.cookie.split('=')[1];await pool.query("UPDATE sessions SET mfa_verified_at=now()-interval '11 minutes' WHERE token_hash=$1",[hashToken(token)]);
 const denied=await request('/api/users',undefined,verified);assert.equal(denied.status,403);assert.equal(denied.data.code,'MFA_REAUTH_REQUIRED');
 assert.equal((await request('/api/auth/mfa/reauth',{password:'wrong',code:codes[0]},verified)).status,400);
 assert.equal((await request('/api/auth/mfa/reauth',{password},verified)).status,400);
 const reauth=await request('/api/auth/mfa/reauth',{password,code:codes[0]},verified);assert.equal(reauth.status,200);const active=session(reauth);
 assert.notEqual(active.cookie,verified.cookie);assert.equal((await request('/api/users',undefined,active)).status,200);
 assert.equal((await request('/api/auth/mfa/replace',{password,code:codes[1]},{...active,csrfToken:'wrong'})).status,403);
 const replacement=await request('/api/auth/mfa/replace',{password,code:codes[1]},active);assert.equal(replacement.status,200);
 assert.notEqual(replacement.data.secret,secret);
 // Old factor remains until explicit confirmation; pending setup expires independently.
 await pool.query("UPDATE users SET mfa_pending_until=now()-interval '1 second' WHERE id=$1",[u.id]);
 assert.equal((await request('/api/auth/mfa/confirm',{code:await generate({secret:replacement.data.secret})},active)).status,400);
 assert.equal((await pool.query('SELECT mfa_secret FROM users WHERE id=$1',[u.id])).rows[0].mfa_secret.split(':')[0],'v1');
 await pool.query("UPDATE sessions SET last_seen_at=now()-interval '16 minutes' WHERE token_hash=$1",[hashToken(active.cookie.split('=')[1])]);
 assert.equal((await request('/api/auth/me',undefined,active)).status,401);
 const pending=await login(u);await pool.query("UPDATE sessions SET created_at=now()-interval '6 minutes' WHERE token_hash=$1",[hashToken(pending.cookie.split('=')[1])]);assert.equal((await request('/api/auth/me',undefined,pending)).status,401);
 const next=await login(u);const confirmed=await request('/api/auth/mfa/verify',{code:codes[2]},next);assert.equal(confirmed.status,200);const final=session(confirmed);
 await pool.query("UPDATE sessions SET created_at=now()-interval '9 hours' WHERE token_hash=$1",[hashToken(final.cookie.split('=')[1])]);assert.equal((await request('/api/auth/me',undefined,final)).status,401);
 const again=await login(u),ok=await request('/api/auth/mfa/verify',{code:codes[3]},again);assert.equal(ok.status,200);const logged=session(ok);assert.equal((await request('/api/auth/logout',{},logged)).status,204);assert.equal((await request('/api/auth/me',undefined,logged)).status,401);
});

test('SEC-05: TOTP novo aceito, anti-replay persiste após reinício; jogadores não acessam MFA',async()=>{
 const {u,secret}=await enrolled();const pending=await login(u);
 const realNow=Date.now;Date.now=()=>realNow()+30_000;
 let verified;
 try{const code=await generate({secret});const ok=await request('/api/auth/mfa/verify',{code},pending);assert.equal(ok.status,200);verified=session(ok);
  await app.close();app=await createApp();await app.listen(0,'127.0.0.1');url=await app.getUrl();
  const next=await login(u);assert.equal((await request('/api/auth/mfa/verify',{code},next)).status,400);
 }finally{Date.now=realNow;}
 const player=await user('JOGADOR'),s=await login(player);assert.equal(s.mfa,'not-required');assert.equal((await request('/api/auth/mfa/enroll',{password},s)).status,403);
 assert.equal((await request('/api/games',undefined,s)).status,200);
 await app.get(AuditService).flush();const serialized=JSON.stringify((await pool.query('SELECT * FROM security_audit')).rows);
 for(const value of [password,secret,verified.cookie,verified.csrfToken])assert.ok(!serialized.includes(value));
});

test('SEC-05: tentativas por ator são persistentes e segredo adulterado falha fechado',async()=>{
 const {u,secret,verified}=await enrolled();
 for(let i=0;i<8;i++)assert.equal((await request('/api/auth/mfa/reauth',{password:'wrong',code:'000000'},verified)).status,400);
 assert.equal((await request('/api/auth/mfa/reauth',{password,code:await generate({secret})},verified)).status,429);
 await app.close();app=await createApp();await app.listen(0,'127.0.0.1');url=await app.getUrl();assert.equal((await request('/api/auth/mfa/reauth',{password,code:'000000'},verified)).status,429);
 await pool.query('DELETE FROM login_attempts WHERE key=$1',[hashToken(`mfa-actor:${u.id}`)]);
 await pool.query("UPDATE users SET mfa_secret='v1:invalid:invalid:invalid' WHERE id=$1",[u.id]);assert.equal((await request('/api/auth/mfa/reauth',{password,code:await generate({secret})},verified)).status,503);
});
