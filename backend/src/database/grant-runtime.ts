import { readFile } from 'node:fs/promises';
import { createPool } from './database.service.js';

// Dumps intentionally omit ACLs. Reapply only current runtime grants after
// restoring/migrating a new database; never rewrite migration checksums.
const pool = createPool();
try {
  const role = await pool.query("SELECT 1 FROM pg_roles WHERE rolname='emulador_runtime'");
  if (!role.rowCount) throw new Error('Provisione o papel runtime antes de conceder acesso.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',current_database()); END $$");
    await client.query(await readFile(new URL('../../migrations/010-runtime-grants.sql', import.meta.url), 'utf8'));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  console.log('Permissões runtime aplicadas ao banco selecionado.');
} catch { console.error('Falha ao aplicar permissões runtime; verifique provisionamento, schema e papel migrador.'); process.exitCode = 1; }
finally { await pool.end(); }
