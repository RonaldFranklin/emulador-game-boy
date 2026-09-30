import { createPool } from '../database/database.service.js';
import { BootstrapError } from './bootstrap-common.js';
import { bootstrapMasterFromEnv, DEFAULT_BOOTSTRAP_ENV_FILE } from './bootstrap-env.js';

async function main() {
  if (process.argv.length !== 2) throw new BootstrapError('Execute o bootstrap pela configuração local, sem argumentos.');
  const pool = createPool();
  try {
    const result = await bootstrapMasterFromEnv(pool, process.env.BOOTSTRAP_ENV_FILE ?? DEFAULT_BOOTSTRAP_ENV_FILE);
    console.log(result === 'created'
      ? 'Primeiro master criado. Entre pela interface com as credenciais configuradas.'
      : 'Bootstrap inicial dispensado: já existe um master. Nenhuma conta foi alterada.');
  } finally { await pool.end(); }
}

try { await main(); } catch (error) {
  console.error(error instanceof BootstrapError ? error.message : 'Bootstrap não concluído. Confira banco, migrações e configuração local.');
  process.exitCode = 1;
}
