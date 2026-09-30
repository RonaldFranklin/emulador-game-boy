import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import pg, { type PoolClient } from 'pg';
import { databaseConfig } from '../config.js';

export function createPool(): pg.Pool {
  const pool = new pg.Pool(databaseConfig());
  pool.on('error', () => new Logger('Database').error('Conexão ociosa com o banco interrompida.'));
  return pool;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool = createPool();

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() { await this.pool.end(); }
}
