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
const login = (username = 'missing', password = 'incorrect_password', options = {}) => request('/api/auth/login', { body: { username, password }, ...options });
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
beforeEach(async () => { await pool.query('DELETE FROM login_attempts'); });
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

test('limites de rajada, conta e geral têm janelas independentes e Retry-After', async () => {
  for (let i = 0; i < 30; i++) assert.equal((await request(i % 2 ? '/API/AUTH/LOGIN/' : '/api/auth/login', { body: { username: 'bad name', password: secret } })).status, 400);
  assert.equal((await login('security_master', secret)).status, 429);
  assert.equal(await history(), undefined); // No hash/admission for invalid bodies.
  assert.equal((await request('/api/auth/me', { headers: authHeaders() })).status, 200);
  await pool.query("UPDATE login_attempts SET window_start=clock_timestamp()-interval '61 seconds' WHERE key=$1", [key('login-burst:127.0.0.2')]);
  assert.equal((await login('security_master', secret)).status, 200);
  await pool.query('UPDATE login_attempts SET attempts=10 WHERE key=$1', [key('username:security_master')]);
  assert.equal((await login('security_master', secret, { ip: '127.0.0.5' })).status, 429);
  await pool.query('UPDATE login_attempts SET attempts=1199 WHERE key=$1', [key('requests:127.0.0.2')]);
  assert.equal((await request('/api/auth/me', { headers: authHeaders() })).status, 200);
  const limited = await request('/api/auth/me', { headers: authHeaders() });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers['retry-after']) <= 60);
  await pool.query("UPDATE login_attempts SET window_start=clock_timestamp()-interval '61 seconds' WHERE key=$1", [key('requests:127.0.0.2')]);
  assert.equal((await request('/api/auth/me', { headers: authHeaders() })).status, 200);
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
