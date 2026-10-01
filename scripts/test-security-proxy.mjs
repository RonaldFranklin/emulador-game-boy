import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { run, compose } from './docker.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const suffix = randomBytes(10).toString('hex');
const database = `emulador_security_${suffix}`;
const network = `emulador-security-${suffix}`;
const api = `${network}-api`, frontend = `${network}-frontend`;
const clients = [`${network}-a`, `${network}-b`];
const owned = [];
let ownsDatabase = false, ownsNetwork = false, frontendUrl;
const sql = query => run(compose('exec','-T','--user','postgres','database','psql','-U','postgres','-d',database,'-At','-v','ON_ERROR_STOP=1','-c',query), { quiet:true });
const request = async (client, username) => JSON.parse(await run(['exec',client,'node','--input-type=module','-e',`
  const result = await fetch(${JSON.stringify(`${frontendUrl}/api/auth/login`)}, {
    method:'POST', headers:{Host:'127.0.0.1:5173',Origin:'http://127.0.0.1:5173','X-Requested-With':'XMLHttpRequest',
    'Content-Type':'application/json','X-Forwarded-For':'203.0.113.123',Forwarded:'for=192.0.2.1','X-Real-IP':'198.51.100.1'},
    body:JSON.stringify({username:${JSON.stringify(username)},password:'incorrect_password'}),signal:AbortSignal.timeout(10000)
  });
  console.log(JSON.stringify({status:result.status,retry:result.headers.get('retry-after'),body:await result.json()}));
`], { quiet:true }));
async function ready() {
  for (let i=0; i<40; i++) {
    try {
      await run(['exec',api,'node','-e',"fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],{quiet:true}); return;
    } catch { await sleep(500); }
  }
  throw new Error('API isolada não ficou pronta.');
}
try {
  await run(compose('exec','-T','--user','postgres','database','createdb','-U','postgres','--template=template0','--owner=emulador',database)); ownsDatabase=true;
  await run(compose('run','--rm','--no-deps','-T','-e',`PGDATABASE=${database}`,'migrate'),{quiet:true});
  await run(['network','create','--internal',network]); ownsNetwork=true;
  await run(compose('run','--detach','--no-deps','--name',api,'-e',`PGDATABASE=${database}`,'-e',`TRUSTED_PROXY_HOST=${frontend}`,'migrate','npm','run','start','--workspace','backend'),{quiet:true}); owned.push(api);
  await run(['network','connect',network,api]);
  await ready(); // Proves startup health does not depend on frontend DNS existing.
  await run(['run','--detach','--name',frontend,'--network',network,'-e',`API_PROXY_TARGET=http://${api}:3001`,'emulador-game-boy-frontend:dev'],{quiet:true}); owned.push(frontend);
  const frontendInfo = JSON.parse(await run(['inspect',frontend]));
  frontendUrl = `http://${frontendInfo[0].NetworkSettings.Networks[network].IPAddress}:5173`;
  for (const client of clients) {
    await run(['run','--detach','--name',client,'--network',network,'emulador-game-boy-backend:dev','node','-e','setInterval(()=>{},1000)'],{quiet:true}); owned.push(client);
  }
  for(let i=0;i<40;i++) {
    try { await run(['exec',clients[0],'node','-e',`fetch('${frontendUrl}/api/health',{headers:{Host:'127.0.0.1:5173'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],{quiet:true}); break; }
    catch(error) { if(i===39) throw new Error('Proxy Vite isolado não respondeu ao health via cliente.', { cause:error }); await sleep(500); }
  }
  assert.equal((await request(clients[0],'missing_one')).status,401);
  assert.equal((await request(clients[0],'missing_two')).status,401);
  const third=await request(clients[0],'missing_three'); assert.equal(third.status,429); assert.equal(third.retry,'7200');
  assert.equal((await request(clients[1],'missing_other')).status,401);
  const keys=[];
  for(const client of clients) {
    const inspected=JSON.parse(await run(['inspect',client]));
    const ip=inspected[0].NetworkSettings.Networks[network].IPAddress;
    keys.push(createHash('sha256').update(`login-failures:${ip}`).digest('hex'));
  }
  assert.notEqual(keys[0],keys[1]);
  assert.equal(await sql(`SELECT cardinality(failure_times) FROM login_attempts WHERE key='${keys[0]}'`),'3');
  assert.equal(await sql(`SELECT cardinality(failure_times) FROM login_attempts WHERE key='${keys[1]}'`),'1');
  const deadline=await sql(`SELECT blocked_until FROM login_attempts WHERE key='${keys[0]}'`);
  await run(['restart',api],{quiet:true}); await ready();
  assert.equal((await request(clients[0],'after_restart')).status,429);
  assert.equal(await sql(`SELECT blocked_until FROM login_attempts WHERE key='${keys[0]}'`),deadline);
  const role=await sql("SELECT rolsuper OR rolcreatedb FROM pg_roles WHERE rolname='emulador'"); assert.equal(role,'f');
  console.log('PASS: Vite → backend em containers reais; dois clientes distintos; spoofing substituído; terceira falha 429/7200; reinício preserva prazo; health sem frontend; papel limitado.');
} finally {
  for(const container of owned.reverse()) await run(['rm','--force',container],{quiet:true});
  if(ownsNetwork) await run(['network','rm',network],{quiet:true});
  if(ownsDatabase) await run(compose('exec','-T','--user','postgres','database','dropdb','-U','postgres','--force',database),{quiet:true});
}
