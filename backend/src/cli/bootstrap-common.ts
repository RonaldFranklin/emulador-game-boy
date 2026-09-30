import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { hashPassword } from '../auth/password.js';

export const BOOTSTRAP_LOCK_KEY = 7113202602;
export class BootstrapError extends Error {}
export interface BootstrapCredentials { username: string; password: string; }
export type BootstrapResult = 'created' | 'exists';

export function validateBootstrapCredentials(input: { username: unknown; password: unknown }): BootstrapCredentials {
  if (typeof input.username !== 'string' || !/^[a-z0-9_]{3,32}$/.test(input.username)) {
    throw new BootstrapError('Nome de usuário inválido: use 3–32 caracteres a-z, 0-9 ou _.');
  }
  if (typeof input.password !== 'string' || Array.from(input.password).length < 12 || Array.from(input.password).length > 128) {
    throw new BootstrapError('A senha deve ter entre 12 e 128 caracteres.');
  }
  return { username: input.username, password: input.password };
}

/** Both entry points share one database lock. Read credentials only when needed. */
export async function bootstrapFirstMaster(
  pool: Pool,
  credentialsProvider: () => Promise<{ username: unknown; password: unknown }>,
  whenExisting: 'error' | 'skip' = 'error',
): Promise<BootstrapResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);
    if ((await client.query("SELECT 1 FROM users WHERE role = 'MASTER' LIMIT 1")).rowCount) {
      if (whenExisting === 'error') throw new BootstrapError('Já existe um master. O bootstrap inicial não altera contas existentes.');
      await client.query('COMMIT');
      return 'exists';
    }
    const credentials = validateBootstrapCredentials(await credentialsProvider());
    if ((await client.query('SELECT 1 FROM users WHERE username = $1', [credentials.username])).rowCount) {
      throw new BootstrapError('Nome de usuário indisponível. O bootstrap não promove nem redefine contas existentes.');
    }
    const hash = await hashPassword(credentials.password);
    credentials.password = '';
    await client.query("INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, 'MASTER')", [randomUUID(), credentials.username, hash]);
    await client.query('COMMIT');
    return 'created';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    // A concurrent out-of-band insert can also claim the username. Do not expose PG details.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new BootstrapError('Nome de usuário indisponível. O bootstrap não promove nem redefine contas existentes.');
    }
    throw error;
  } finally { client.release(); }
}
