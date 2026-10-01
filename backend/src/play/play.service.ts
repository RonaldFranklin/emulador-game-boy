import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hashToken, type SessionIdentity } from '../auth/session.js';
import { SessionService } from '../auth/session.service.js';
import { CATALOG_LOCK_KEY } from '../games/catalog-constants.js';
import { CatalogStorageService } from '../games/catalog-storage.service.js';
import type { GameRow } from '../games/game.js';
import { CORE_FOR_CONSOLE, LEASE_RENEW_SECONDS, LEASE_TTL_SECONDS, MAX_SAVE_BYTES, MAX_SAVES, MAX_SAVES_BYTES } from './play-constants.js';
import { acquireInput, decodeSave, leaseInput, saveInput } from './play-input.js';

interface SaveRow { data: Buffer; sha256: string; size: number; version: number; created_at: Date; updated_at: Date; }
interface LeaseRow { token_hash: string; session_token_hash: string; expires_at: Date; valid: boolean; }
const saveMetadata = (save: SaveRow) => ({ version: save.version, sha256: save.sha256, updatedAt: save.updated_at.toISOString() });

@Injectable()
export class PlayService {
  private readonly logger = new Logger('Play');
  constructor(private readonly sessions: SessionService, private readonly storage: CatalogStorageService) {}

  manifest(id: string, identity: SessionIdentity) {
    return this.withGame(id, identity, false, async (client, game) => ({
      game: { id: game.id, name: game.name, console: game.console },
      save: (await client.query<{ version: number; updatedAt: Date }>(
        'SELECT version, updated_at AS "updatedAt" FROM game_saves WHERE user_id=$1 AND game_id=$2',
        [identity.user.id, id],
      )).rows[0] ?? null,
      core: CORE_FOR_CONSOLE[game.console],
      romUrl: `/api/play/${game.id}/rom`,
      maxSaveBytes: MAX_SAVE_BYTES,
      leaseTtlSeconds: LEASE_TTL_SECONDS,
      renewAfterSeconds: LEASE_RENEW_SECONDS,
    }));
  }

  rom(id: string, identity: SessionIdentity): Promise<Buffer> {
    return this.withGame(id, identity, false, async (_client, game) => {
      try { return await this.storage.readRom(game.rom_key, game.rom_size, game.rom_sha256); }
      catch {
        this.logger.error('ROM referenciada indisponível ou com integridade inválida.');
        throw new ServiceUnavailableException('A ROM está indisponível. Solicite verificação do catálogo.');
      }
    });
  }

  reservation(id: string, identity: SessionIdentity) {
    return this.withGame(id, identity, false, async client => {
      const row = (await client.query<LeaseRow>(
        `SELECT l.* FROM play_leases l JOIN sessions s ON s.token_hash=l.session_token_hash
         WHERE l.user_id=$1 AND l.game_id=$2 AND l.expires_at > clock_timestamp()
           AND s.expires_at > clock_timestamp()`, [identity.user.id, id],
      )).rows[0];
      // Observation only: never expose the token that authorizes writing.
      return { reservation: row ? { generation: hashToken(row.token_hash), expiresAt: row.expires_at.toISOString() } : null };
    });
  }

  acquire(id: string, identity: SessionIdentity, body: unknown) {
    const expected = acquireInput(body);
    return this.withGame(id, identity, true, async (client) => {
      const current = (await client.query<LeaseRow>(
        `SELECT l.*, l.expires_at > clock_timestamp() AND s.expires_at > clock_timestamp() AS valid
         FROM play_leases l JOIN sessions s ON s.token_hash=l.session_token_hash
         WHERE l.user_id=$1 AND l.game_id=$2 FOR UPDATE OF l`, [identity.user.id, id],
      )).rows[0];
      // Compare the observed generation under the same transaction/locks as
      // save and renew. A second takeover of that generation must lose.
      if (expected !== undefined && (!current || hashToken(current.token_hash) !== expected)) {
        throw new ConflictException('A reserva mudou desde a confirmação. Confira novamente antes de assumir.');
      }
      if (current?.valid && expected === undefined) {
        throw new ConflictException('Existe uma reserva de jogo ativa. Ela pode ser de outra aba ou de uma aba fechada/recarregada. Aguarde ou escolha encerrar a sessão anterior.');
      }
      const token = randomUUID();
      const lease = await client.query<{ expires_at: Date }>(
        `INSERT INTO play_leases (user_id,game_id,token_hash,session_token_hash,expires_at)
         VALUES ($1,$2,$3,$4,clock_timestamp()+$5*interval '1 second')
         ON CONFLICT (user_id,game_id) DO UPDATE SET token_hash=excluded.token_hash,
           session_token_hash=excluded.session_token_hash,expires_at=excluded.expires_at,created_at=clock_timestamp()
         RETURNING expires_at`, [identity.user.id, id, hashToken(token), identity.tokenHash, LEASE_TTL_SECONDS],
      );
      const epoch = (await client.query<{epoch:string}>('SELECT epoch FROM save_resets WHERE user_id=$1 AND game_id=$2', [identity.user.id,id])).rows[0]?.epoch ?? null;
      const saved = (await client.query<SaveRow>('SELECT * FROM game_saves WHERE user_id=$1 AND game_id=$2', [identity.user.id, id])).rows[0];
      // Read save and acquire lease atomically. A new boot must never race an old writer.
      return {
        leaseId: token, expiresAt: lease.rows[0]!.expires_at.toISOString(), renewAfterSeconds: LEASE_RENEW_SECONDS,
        save: saved ? { epoch, ...saveMetadata(saved), dataBase64: saved.data.toString('base64') }
          : { epoch, dataBase64: null, sha256: null, version: 0, updatedAt: null },
      };
    });
  }

  renew(id: string, identity: SessionIdentity, body: unknown) {
    const token = leaseInput(body);
    return this.withGame(id, identity, true, async (client) => {
      await this.requireLease(client, id, identity, token);
      const result = await client.query<{ expires_at: Date }>(
        `UPDATE play_leases SET expires_at=clock_timestamp()+$3*interval '1 second'
         WHERE user_id=$1 AND game_id=$2 RETURNING expires_at`, [identity.user.id, id, LEASE_TTL_SECONDS],
      );
      return { expiresAt: result.rows[0]!.expires_at.toISOString() };
    });
  }

  release(id: string, identity: SessionIdentity, body: unknown) {
    const token = leaseInput(body);
    return this.withGame(id, identity, true, async (client) => {
      // Conditional delete makes network retries harmless and cannot release another tab's lease.
      await client.query(
        'DELETE FROM play_leases WHERE user_id=$1 AND game_id=$2 AND token_hash=$3 AND session_token_hash=$4',
        [identity.user.id, id, hashToken(token), identity.tokenHash],
      );
    });
  }

  save(id: string, identity: SessionIdentity, body: unknown) {
    const input = saveInput(body);
    return this.withGame(id, identity, true, async (client) => {
      await this.requireLease(client, id, identity, input.leaseId);
      const epoch = (await client.query<{epoch:string}>('SELECT epoch FROM save_resets WHERE user_id=$1 AND game_id=$2',[identity.user.id,id])).rows[0]?.epoch ?? null;
      if ((input.epoch ?? null) !== epoch) throw new ConflictException('O progresso nativo foi reiniciado. A pendência anterior foi preservada e não pode ser enviada automaticamente.');
      const data = decodeSave(input.dataBase64);
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (input.sha256 !== undefined && input.sha256 !== sha256) throw new BadRequestException('O checksum não corresponde ao progresso enviado.');
      const existing = (await client.query<SaveRow & { too_soon: boolean }>(
        `SELECT *,updated_at > clock_timestamp()-interval '1 second' AS too_soon
         FROM game_saves WHERE user_id=$1 AND game_id=$2 FOR UPDATE`, [identity.user.id, id],
      )).rows[0];
      const version = existing?.version ?? 0;
      if (existing && existing.sha256 === sha256 && (input.baseVersion === version || input.baseVersion === version - 1)) {
        return { save: saveMetadata(existing) };
      }
      if (input.baseVersion !== version) throw new ConflictException('Existe uma versão mais recente do progresso. Reabra o jogo para carregá-la; o save existente foi preservado.');
      if (version === 2147483647) throw new ConflictException('O limite de versões deste progresso foi atingido. Solicite revisão local.');
      if (existing?.too_soon) throw new HttpException({ message: 'Aguarde um segundo entre alterações de progresso.', retryAfterSeconds: 1 }, HttpStatus.TOO_MANY_REQUESTS);
      const quota = (await client.query<{ bytes: string; count: number }>(
        'SELECT coalesce(sum(size),0)::text AS bytes,count(*)::integer AS count FROM game_saves',
      )).rows[0]!;
      if (Number(quota.bytes) - (existing?.size ?? 0) + data.length > MAX_SAVES_BYTES || (!existing && quota.count >= MAX_SAVES)) {
        throw new HttpException('O armazenamento de progresso atingiu a quota local de 1 GiB ou 10.000 saves. O save anterior foi preservado.', HttpStatus.INSUFFICIENT_STORAGE);
      }
      const saved = (await client.query<SaveRow>(
        `INSERT INTO game_saves (user_id,game_id,data,sha256,size,version) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id,game_id) DO UPDATE SET data=excluded.data,sha256=excluded.sha256,
           size=excluded.size,version=excluded.version,updated_at=clock_timestamp() RETURNING *`,
        [identity.user.id, id, data, sha256, data.length, version + 1],
      )).rows[0]!;
      return { save: saveMetadata(saved) };
    });
  }

  async requireLease(client: PoolClient, id: string, identity: SessionIdentity, token: string) {
    const lease = (await client.query<LeaseRow>(
      `SELECT *,expires_at > clock_timestamp() AS valid FROM play_leases
       WHERE user_id=$1 AND game_id=$2 FOR UPDATE`, [identity.user.id, id],
    )).rows[0];
    if (!lease?.valid || lease.token_hash !== hashToken(token) || lease.session_token_hash !== identity.tokenHash) {
      throw new ConflictException('Esta aba perdeu a reserva de jogo: ela expirou ou foi assumida em outra aba. O jogo foi pausado; o save confirmado permanece protegido.');
    }
  }

  withGame<T>(id: string, identity: SessionIdentity, mutation: boolean, work: (client: PoolClient, game: GameRow) => Promise<T>): Promise<T> {
    return this.sessions.withActor(identity, {}, async (client) => {
      if (mutation) await client.query('SELECT pg_advisory_xact_lock($1)', [CATALOG_LOCK_KEY]);
      // Both roles can only play active games. The share lock serializes deactivation.
      const game = (await client.query<GameRow>('SELECT * FROM games WHERE id=$1 AND active FOR SHARE', [id])).rows[0];
      if (!game) throw new NotFoundException('Jogo indisponível para jogar.');
      return work(client, game);
    });
  }
}
