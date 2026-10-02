import { randomBytes } from 'node:crypto';
import { readFile, appendFile, mkdir, open, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
await mkdir('.local/secrets', { recursive: true, mode: 0o700 });
await chmod('.local', 0o700);
await chmod('.local/secrets', 0o700);
await mkdir('.local/screenshots', { recursive: true, mode: 0o700 });
await chmod('.local/screenshots', 0o700);
for (const name of ['postgres_password', 'app_db_password', 'runtime_db_password', 'mfa_encryption_key']) {
  try {
    // The containing directory is private (0700). Compose bind-mounted secrets
    // must also be readable by PostgreSQL's container UID, which differs from the host UID.
    const file = await open(`.local/secrets/${name}`, 'wx', 0o644);
    try { await file.writeFile((name === 'mfa_encryption_key' ? randomBytes(32).toString('hex') : randomBytes(36).toString('base64url')) + '\n'); }
    finally { await file.close(); }
    console.log(`Criado arquivo secreto ${name} (conteúdo omitido).`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(`Preservado arquivo secreto ${name}.`);
  }
  await chmod(`.local/secrets/${name}`, 0o644);
}
try {
  const file = await open('.env', 'wx', 0o600);
  try { await file.writeFile(await readFile('.env.example')); }
  finally { await file.close(); }
}
catch (error) { if (error.code !== 'EEXIST') throw error; }
await chmod('.env', 0o600);
// Add only the new non-secret selector when upgrading an older .env.
// ADMIN credentials and all existing configuration are preserved verbatim.
if (!/^\s*(?:export\s+)?BOOTSTRAP_ENV_SOURCE\s*=/m.test(await readFile('.env', 'utf8'))) {
  await appendFile('.env', '\nBOOTSTRAP_ENV_SOURCE=./.env\n');
}
console.log('Configuração local pronta (.env privada: 0600). Valores existentes preservados.');
console.log('No primeiro boot sem master, escolha ADMIN_USERNAME e ADMIN_PASSWORD na .env antes de subir.');
console.log('Em banco já provisionado, não é necessário preencher essas chaves; elas não redefinem contas.');
