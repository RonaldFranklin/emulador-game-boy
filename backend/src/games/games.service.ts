import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SessionIdentity } from '../auth/session.js';
import { SessionService } from '../auth/session.service.js';
import { CatalogStorageService, type CatalogFile } from './catalog-storage.service.js';
import { CATALOG_LOCK_KEY, MAX_GAMES } from './catalog-constants.js';
import { catalogInput } from './catalog-input.js';
import { validateRom } from './rom-validation.js';
import { validateCover } from './cover-validation.js';
import { publicGame, type GameRow } from './game.js';
import type { CatalogRequest } from './catalog-upload.interceptor.js';

@Injectable()
export class GamesService {
  private readonly logger = new Logger('Catalog');
  constructor(private readonly sessions: SessionService, private readonly storage: CatalogStorageService) {}

  async list(identity: SessionIdentity) {
    return this.sessions.withActor(identity, {}, async (client, user) => {
      const result = await client.query<GameRow>('SELECT * FROM games WHERE ($1::boolean OR active) ORDER BY lower(name), id', [user.role === 'MASTER']);
      return { games: result.rows.map(publicGame) };
    });
  }

  async create(request: CatalogRequest) {
    const input = catalogInput(request.body, true);
    const rom = request.files.rom?.[0];
    const cover = request.files.cover?.[0];
    if (!rom) throw new BadRequestException('Envie a ROM .gb ou .gba do jogo.');
    const header = validateRom(rom.buffer, rom.originalname);
    const coverBuffer = cover ? await validateCover(cover.buffer) : undefined;
    return this.mutate(request.identity, async (client, owned) => {
      if ((await client.query('SELECT 1 FROM games WHERE rom_sha256 = $1', [header.sha256])).rowCount) {
        throw new ConflictException('Esta ROM já está cadastrada, mesmo que o nome do arquivo seja diferente.');
      }
      const count = await client.query<{ count: number }>('SELECT count(*)::integer AS count FROM games');
      if (count.rows[0]!.count >= MAX_GAMES) throw new ConflictException('O catálogo atingiu o limite local de 1000 jogos.');
      await this.storage.assertCapacity(rom.buffer.length + (coverBuffer?.length ?? 0), coverBuffer ? 2 : 1);
      const storedRom = await this.storage.write('roms', rom.buffer, header.console);
      owned.push(storedRom);
      const storedCover = coverBuffer ? await this.storage.write('covers', coverBuffer) : undefined;
      if (storedCover) owned.push(storedCover);
      const result = await client.query<GameRow>(
        `INSERT INTO games (id, name, active, rom_key, rom_sha256, rom_size, cartridge_type, cgb_flag, cover_key, cover_sha256, cover_size, console)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [randomUUID(), input.name, input.active, storedRom.key, header.sha256, header.size, header.cartridgeType, header.cgbFlag,
          storedCover?.key ?? null, storedCover?.sha256 ?? null, storedCover?.size ?? null, header.console],
      );
      return { game: publicGame(result.rows[0]!) };
    });
  }

  async update(id: string, request: CatalogRequest) {
    const input = catalogInput(request.body, false);
    const cover = request.files.cover?.[0];
    if (input.removeCover && cover) throw new BadRequestException('Escolha enviar uma capa ou remover a atual, não ambos.');
    if (input.name === undefined && input.active === undefined && !input.removeCover && !cover) throw new BadRequestException('Informe pelo menos uma alteração.');
    const coverBuffer = cover ? await validateCover(cover.buffer) : undefined;
    return this.mutate(request.identity, async (client, owned) => {
      const found = await client.query<GameRow>('SELECT * FROM games WHERE id = $1 FOR UPDATE', [id]);
      const game = found.rows[0];
      if (!game) throw new NotFoundException('Jogo não encontrado.');
      let key = game.cover_key, hash = game.cover_sha256, size = game.cover_size;
      if (input.removeCover) { key = null; hash = null; size = null; }
      if (coverBuffer) {
        await this.storage.assertCapacity(coverBuffer.length, 1);
        const storedCover = await this.storage.write('covers', coverBuffer);
        owned.push(storedCover);
        key = storedCover.key; hash = storedCover.sha256; size = storedCover.size;
      }
      const result = await client.query<GameRow>(
        `UPDATE games SET name=$2, active=$3, cover_key=$4, cover_sha256=$5, cover_size=$6,
         updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [id, input.name ?? game.name, input.active ?? game.active, key, hash, size],
      );
      // Previously referenced files are intentionally retained for consistent backups and recovery.
      return { game: publicGame(result.rows[0]!) };
    });
  }

  async cover(id: string, identity: SessionIdentity): Promise<Buffer> {
    return this.sessions.withActor(identity, {}, async (client, user) => {
      const found = await client.query<GameRow>('SELECT * FROM games WHERE id=$1 AND ($2::boolean OR active) FOR SHARE', [id, user.role === 'MASTER']);
      const game = found.rows[0];
      if (!game?.cover_key || !game.cover_sha256 || !game.cover_size) throw new NotFoundException('Capa não encontrada.');
      try { return await this.storage.readCover(game.cover_key, game.cover_size, game.cover_sha256); }
      catch {
        this.logger.error('Capa referenciada indisponível ou com integridade inválida.');
        throw new ServiceUnavailableException('A capa está indisponível. Solicite verificação do catálogo.');
      }
    });
  }

  private async mutate<T>(identity: SessionIdentity, work: (client: PoolClient, owned: CatalogFile[]) => Promise<T>): Promise<T> {
    try {
      return await this.sessions.withActor(identity, { master: true }, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [CATALOG_LOCK_KEY]);
        const owned: CatalogFile[] = [];
        try { return await work(client, owned); }
        catch (error) {
          // Cleanup runs while the advisory lock is held, before the transaction rollback.
          for (const file of owned) await this.storage.removeOwn(file);
          throw error;
        }
      });
      // A COMMIT/network failure happens outside the callback above: retain files when outcome is ambiguous.
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new ConflictException('Esta ROM já está cadastrada.');
      }
      throw error;
    }
  }
}
