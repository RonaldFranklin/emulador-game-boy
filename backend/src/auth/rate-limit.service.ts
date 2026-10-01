import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { hashToken } from './session.js';

export function limited(message: string, retryAfterSeconds: number) {
  return new HttpException({ message, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) }, 429);
}

@Injectable()
export class RateLimitService {
  constructor(private readonly database: DatabaseService) {}

  async bucket(namespace: string, identity: string, maximum: number, seconds: number, client?: PoolClient): Promise<void> {
    const result = await (client ?? this.database.pool).query<{ attempts: number; retry: number }>(
      `INSERT INTO login_attempts (key, attempts, window_start) VALUES ($1, 1, clock_timestamp())
       ON CONFLICT (key) DO UPDATE SET
         attempts = CASE WHEN login_attempts.window_start <= clock_timestamp() - $2 * interval '1 second'
           THEN 1 ELSE LEAST(login_attempts.attempts + 1, $3 + 1) END,
         window_start = CASE WHEN login_attempts.window_start <= clock_timestamp() - $2 * interval '1 second'
           THEN clock_timestamp() ELSE login_attempts.window_start END
       RETURNING attempts, CEIL(EXTRACT(EPOCH FROM window_start + $2 * interval '1 second' - clock_timestamp()))::integer AS retry`,
      [hashToken(`${namespace}:${identity}`), seconds, maximum],
    );
    if (result.rows[0]!.attempts > maximum) {
      throw limited('Muitas requisições. Aguarde o prazo indicado antes de tentar novamente.', result.rows[0]!.retry);
    }
  }

  async claim(username: string, ip: string, client?: PoolClient): Promise<void> {
    await this.bucket('ip', ip, 100, 900, client);
    await this.bucket('username', username, 10, 900, client);
  }

  async login<T>(ip: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const key = hashToken(`login-failures:${ip}`);
    const outcome = await this.database.transaction(async (client) => {
      // Nonblocking per-IP admission BEFORE Argon2. Shared by all API processes.
      const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [BigInt.asIntN(64, BigInt(`0x${key.slice(0, 16)}`)).toString()]);
      if (!lock.rows[0]!.locked) return { error: limited('Já existe uma tentativa de login deste IP em andamento. Aguarde um segundo.', 1) };
      await client.query(
        `INSERT INTO login_attempts (key, attempts, window_start) VALUES ($1, 1, clock_timestamp()) ON CONFLICT DO NOTHING`, [key],
      );
      const blocked = await client.query<{ retry: number }>(
        `SELECT CEIL(EXTRACT(EPOCH FROM blocked_until - clock_timestamp()))::integer AS retry FROM login_attempts WHERE key = $1`, [key],
      );
      if (blocked.rows[0]!.retry > 0) return { error: this.blocked(blocked.rows[0]!.retry) };
      // A completed block resets the history; otherwise keep a rolling two-hour window.
      await client.query(
        `UPDATE login_attempts SET failure_times = CASE WHEN blocked_until IS NOT NULL THEN '{}'::timestamptz[]
          ELSE ARRAY(SELECT t FROM unnest(failure_times) AS t WHERE t > clock_timestamp() - interval '2 hours') END,
          blocked_until = NULL, window_start = clock_timestamp() WHERE key = $1`, [key],
      );
      try { return { value: await work(client) }; }
      catch (error) {
        if (!(error instanceof UnauthorizedException)) {
          if (error instanceof HttpException) return { error };
          throw error;
        }
        const failed = await client.query<{ retry: number }>(
          `WITH recent AS (
             SELECT ARRAY(SELECT t FROM unnest(failure_times) AS t
               WHERE t > statement_timestamp() - interval '2 hours') AS times
             FROM login_attempts WHERE key = $1
           ) UPDATE login_attempts SET failure_times = array_append(recent.times, statement_timestamp()),
             blocked_until = CASE WHEN cardinality(recent.times) >= 2 THEN statement_timestamp() + interval '2 hours' ELSE NULL END
           FROM recent WHERE key = $1
           RETURNING CEIL(EXTRACT(EPOCH FROM blocked_until - statement_timestamp()))::integer AS retry`, [key],
        );
        return { error: failed.rows[0]!.retry > 0 ? this.blocked(failed.rows[0]!.retry) : error };
      }
    });
    // Commit failures before returning the HTTP error; never roll them back with it.
    if ('error' in outcome) throw outcome.error;
    await this.database.pool.query(`DELETE FROM login_attempts WHERE key IN (
      SELECT key FROM login_attempts WHERE window_start < clock_timestamp() - interval '1 day'
      AND (blocked_until IS NULL OR blocked_until <= clock_timestamp()) LIMIT 1000 FOR UPDATE SKIP LOCKED
    )`);
    return outcome.value;
  }

  private blocked(seconds: number) {
    return limited(`Login temporariamente bloqueado para este IP após três falhas. Tente novamente em ${Math.ceil(seconds / 60)} minuto(s).`, seconds);
  }
}
