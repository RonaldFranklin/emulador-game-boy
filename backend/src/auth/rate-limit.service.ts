import { HttpException, Injectable, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { hashToken } from './session.js';

export function limited(message: string, retryAfterSeconds: number) {
  return new HttpException({ message, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) }, 429);
}

@Injectable()
export class RateLimitService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private cleaning = false;
  constructor(private readonly database: DatabaseService) {}

  onModuleInit() {
    this.timer = setInterval(() => { void this.cleanup().catch(() => {}); }, 60_000); this.timer.unref();
    void this.cleanup().catch(() => {});
  }
  onModuleDestroy() { clearInterval(this.timer); }
  async cleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      await this.database.pool.query(`DELETE FROM login_attempts WHERE key IN (
        SELECT key FROM login_attempts WHERE expires_at <= clock_timestamp()
        AND (blocked_until IS NULL OR blocked_until <= clock_timestamp()) LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
      await this.database.pool.query(`DELETE FROM sessions WHERE token_hash IN (
        SELECT token_hash FROM sessions WHERE expires_at <= clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    } finally { this.cleaning = false; }
  }
  // New identities serialize only during insertion, never while hashing a password.
  async ensure(key: string, seconds: number, attempts = 1, actor = false, client?: PoolClient) {
    if ((await (client ?? this.database.pool).query('SELECT 1 FROM login_attempts WHERE key=$1',[key])).rowCount) return;
    const insert = async (client: PoolClient) => {
      await client.query('SELECT id FROM security_capacity WHERE id=true FOR UPDATE');
      if ((await client.query('SELECT 1 FROM login_attempts WHERE key=$1',[key])).rowCount) return;
      const scope=actor?'actor':'anonymous';
      const size = await client.query<{n:number}>('SELECT count(*)::int AS n FROM login_attempts WHERE scope=$1',[scope]);
      if (size.rows[0]!.n >= (actor?1000:9000)) throw limited('Serviço ocupado. Tente novamente em um minuto.',60);
      await client.query("INSERT INTO login_attempts(key,attempts,window_start,expires_at,scope) VALUES($1,$2,clock_timestamp()-$3*interval '1 second',clock_timestamp()+$3*interval '1 second',$4)",[key,attempts,seconds,scope]);
    };
    if(client) await insert(client); else await this.database.transaction(insert);
  }
  async bucket(namespace: string, identity: string, maximum: number, seconds: number, client?: PoolClient): Promise<void> {
    const key = hashToken(`${namespace}:${identity}`);
    await this.ensure(key, seconds, 1, true, client);
    const result = await (client ?? this.database.pool).query<{ attempts: number; retry: number }>(
      `UPDATE login_attempts SET attempts=CASE WHEN window_start <= clock_timestamp()-$2*interval '1 second' THEN 1 ELSE LEAST(attempts+1,$3+2) END,
       window_start=CASE WHEN window_start <= clock_timestamp()-$2*interval '1 second' THEN clock_timestamp() ELSE window_start END,
       expires_at=GREATEST(expires_at,clock_timestamp()+$2*interval '1 second') WHERE key=$1
       RETURNING attempts,CEIL(EXTRACT(EPOCH FROM window_start+$2*interval '1 second'-clock_timestamp()))::int AS retry`,
      [key, seconds, maximum]);
    if (!result.rowCount || result.rows[0]!.attempts > maximum) throw limited('Muitas requisições. Aguarde o prazo indicado antes de tentar novamente.', result.rows[0]?.retry ?? 1);
  }

  async admitStateIngress(actorId: string): Promise<void> {
    const keys = [hashToken('states-ingress-global:global'), hashToken(`states-ingress:${actorId}`)];
    // Capacity insertion must finish BEFORE taking any admission row locks.
    // A fresh placeholder represents an expired window, not a charged request.
    for (const key of keys) await this.ensure(key, 60, 1, true);
    await this.database.transaction(async (client) => {
      // All instances use global -> actor. Never ensure/reinsert under these locks:
      // cleanup may have removed a placeholder; fail closed and let the caller retry.
      for (const key of keys) {
        const locked = await client.query('SELECT key FROM login_attempts WHERE key=$1 FOR UPDATE', [key]);
        if (!locked.rowCount) throw limited('Admissão temporariamente indisponível. Tente novamente.', 1);
      }
      const result = await client.query<{key:string; attempts:number; fresh:boolean; retry:number}>(
        `SELECT key,attempts,window_start<=statement_timestamp()-interval '1 minute' AS fresh,
         CEIL(EXTRACT(EPOCH FROM window_start+interval '1 minute'-statement_timestamp()))::int AS retry
         FROM login_attempts WHERE key=ANY($1::text[])`, [keys]);
      const rows = keys.map(key => result.rows.find(row => row.key === key)!);
      const maxima = [120, 20];
      const retry = Math.max(0, ...rows.map((row, index) =>
        !row.fresh && row.attempts >= maxima[index]! ? row.retry : 0));
      if (retry > 0) throw limited('Muitas requisições de estados. Aguarde antes de tentar novamente.', retry);
      for (const row of rows) {
        await client.query(`UPDATE login_attempts SET attempts=$2,
          window_start=CASE WHEN $3 THEN statement_timestamp() ELSE window_start END,
          expires_at=statement_timestamp()+interval '1 minute' WHERE key=$1`,
        [row.key, row.fresh ? 1 : row.attempts + 1, row.fresh]);
      }
    });
    // Commit precedes body parsing/network waits. Later invalid bodies are not refunded.
  }

  async prepareBudget(namespace:string,identity:string) {
    // Insert before acquiring user/catalog/budget locks. Do not invert the
    // global capacity lock with a budget row under concurrent first use.
    await this.ensure(hashToken(`${namespace}:global`),60,1,true);
    await this.ensure(hashToken(`${namespace}:${identity}`),60,1,true);
  }

  async budget(namespace:string,identity:string,operations:number,bytes:number,maxOperations:number,maxBytes:number,client:PoolClient) {
    const key=hashToken(`${namespace}:${identity}`);
    const found=await client.query<{attempts:number;byte_count:string;fresh:boolean;retry:number}>(`SELECT attempts,byte_count,
      window_start<=clock_timestamp()-interval '1 minute' AS fresh,
      CEIL(EXTRACT(EPOCH FROM window_start+interval '1 minute'-clock_timestamp()))::int AS retry
      FROM login_attempts WHERE key=$1 FOR UPDATE`,[key]);
    const row=found.rows[0];if(!row)throw limited('Orçamento temporariamente indisponível.',1);
    const used=row.fresh?0:row.attempts, usedBytes=row.fresh?0:Number(row.byte_count);
    if(used+operations>maxOperations||usedBytes+bytes>maxBytes)throw limited('Limite de operações/bytes de estados atingido. Aguarde antes de tentar novamente.',row.fresh?60:row.retry);
    await client.query(`UPDATE login_attempts SET attempts=$2,byte_count=$3,window_start=CASE WHEN $4 THEN clock_timestamp() ELSE window_start END,expires_at=clock_timestamp()+interval '1 minute' WHERE key=$1`,[key,used+operations,usedBytes+bytes,row.fresh]);
  }

  async claim(username: string, ip: string, client: PoolClient, proof?: { token: string; nonce: string }): Promise<void> {
    // Activity is tracked for existent and nonexistent names alike; it never locks an account.
    const key = hashToken(`login-pressure:${username}`);
    const row = (await client.query<{attempts:number}>(`UPDATE login_attempts SET
      attempts=CASE WHEN window_start<=clock_timestamp()-interval '15 minutes' THEN 1 ELSE LEAST(attempts+1,1000) END,
      window_start=CASE WHEN window_start<=clock_timestamp()-interval '15 minutes' THEN clock_timestamp() ELSE window_start END,
      expires_at=clock_timestamp()+interval '15 minutes' WHERE key=$1 RETURNING attempts`,[key])).rows[0]!;
    if (!row) throw limited('Contagem expirada. Tente novamente.',1);
    if (row.attempts <= 10) return;
    if (proof && /^[a-zA-Z0-9_-]{43}$/.test(proof.token) && /^\d{1,10}$/.test(proof.nonce)) {
      const proofKey=hashToken(`proof:${ip}:${username}:${proof.token}`);
      const used=await client.query<{attempts:number}>('DELETE FROM login_attempts WHERE key=$1 AND expires_at>clock_timestamp() RETURNING attempts',[proofKey]);
      if (used.rowCount && hashToken(`${proof.token}:${proof.nonce}`).startsWith('0'.repeat(used.rows[0]!.attempts))) return;
    }
    const token=randomBytes(32).toString('base64url'), zeros=row.attempts>=30?5:4;
    await this.ensure(hashToken(`proof:${ip}:${username}:${token}`),120,zeros,false,client);
    throw new HttpException({message:'Verificação adicional necessária. Aguarde a verificação no navegador.',challenge:{token,zeros}},428);
  }

  async login<T>(ip: string, username: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const key = hashToken(`login-failures:${ip}`);
    await this.ensure(key, 14400);
    // Prepare capacity outside the hash transaction; never hold the global
    // insertion lock while verifying a password. Recheck the block under lock.
    const preflight=await this.database.pool.query<{retry:number}>("SELECT CEIL(EXTRACT(EPOCH FROM blocked_until-clock_timestamp()))::int AS retry FROM login_attempts WHERE key=$1",[key]);
    if((preflight.rows[0]?.retry ?? 0)>0)throw this.blocked(preflight.rows[0]!.retry);
    await this.ensure(hashToken(`login-pressure:${username}`),900);
    const outcome = await this.database.transaction(async (client) => {
      // Nonblocking per-IP admission BEFORE Argon2. Shared by all API processes.
      const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [BigInt.asIntN(64, BigInt(`0x${key.slice(0, 16)}`)).toString()]);
      if (!lock.rows[0]!.locked) return { error: limited('Já existe uma tentativa de login deste IP em andamento. Aguarde um segundo.', 1) };
      const blocked = await client.query<{ retry: number }>(
        `SELECT CEIL(EXTRACT(EPOCH FROM blocked_until - clock_timestamp()))::integer AS retry FROM login_attempts WHERE key = $1`, [key],
      );
      if (!blocked.rowCount) return {error: limited('Contagem expirada. Tente novamente.',1)};
      if (blocked.rows[0]!.retry > 0) return { error: this.blocked(blocked.rows[0]!.retry) };
      // A completed block resets the history; otherwise keep a rolling two-hour window.
      await client.query(
        `UPDATE login_attempts SET failure_times = CASE WHEN blocked_until IS NOT NULL THEN '{}'::timestamptz[]
          ELSE ARRAY(SELECT t FROM unnest(failure_times) AS t WHERE t > clock_timestamp() - interval '2 hours') END,
          blocked_until = NULL, window_start = clock_timestamp(), expires_at=clock_timestamp()+interval '4 hours' WHERE key = $1`, [key],
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
    return outcome.value;
  }

  private blocked(seconds: number) {
    return limited(`Login temporariamente bloqueado para este IP após três falhas. Tente novamente em ${Math.ceil(seconds / 60)} minuto(s).`, seconds);
  }
}
