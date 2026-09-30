import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

const migrationsDirectory = new URL('../../migrations/', import.meta.url);

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7113202601)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(migrationsDirectory)).filter((name) => /^\d{3}[-a-z0-9]*\.sql$/.test(name)).sort();
    const known = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    for (const applied of known.rows) {
      if (!files.includes(applied.name)) throw new Error(`Migração aplicada ausente: ${applied.name}.`);
    }
    for (const name of files) {
      const sql = await readFile(new URL(name, migrationsDirectory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = known.rows.find((row) => row.name === name);
      if (previous) {
        if (previous.checksum !== checksum) throw new Error(`Migração aplicada foi alterada: ${name}.`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      console.log(`Migração aplicada: ${name}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
