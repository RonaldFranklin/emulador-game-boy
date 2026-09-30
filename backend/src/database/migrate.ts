import { createPool } from './database.service.js';
import { migrate } from './migrations.js';

const pool = createPool();
try {
  await migrate(pool);
  console.log('Banco atualizado.');
} catch {
  console.error('Não foi possível aplicar as migrações. Confira conexão, permissões e integridade dos arquivos.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
