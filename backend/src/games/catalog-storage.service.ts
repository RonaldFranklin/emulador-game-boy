import { HttpException, HttpStatus, Inject, Injectable, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { constants } from 'node:fs';
import { mkdir, open, readdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { CONFIG } from '../auth/session.js';
import { MAX_CATALOG_BYTES, MAX_CATALOG_FILES } from './catalog-constants.js';
import type { GameConsole } from './game.js';

export interface CatalogFile { kind: 'roms' | 'covers'; key: string; sha256: string; size: number; }

@Injectable()
export class CatalogStorageService implements OnModuleInit {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async onModuleInit() {
    for (const directory of ['', 'roms', 'covers']) {
      await mkdir(join(this.config.catalogStorageDir, directory), { recursive: true, mode: 0o700 });
    }
  }

  /** Caller holds CATALOG_LOCK_KEY, also used by backups. Includes retired/orphan files. */
  async assertCapacity(additionalBytes: number, additionalFiles: number) {
    let total = 0;
    let files = 0;
    for (const kind of ['roms', 'covers'] as const) {
      for (const entry of await readdir(join(this.config.catalogStorageDir, kind), { withFileTypes: true })) {
        files += 1;
        if (!entry.isFile()) throw new ServiceUnavailableException('O armazenamento do catálogo exige revisão local.');
        const file = await open(join(this.config.catalogStorageDir, kind, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { total += (await file.stat()).size; } finally { await file.close(); }
      }
    }
    if (total + additionalBytes > MAX_CATALOG_BYTES || files + additionalFiles > MAX_CATALOG_FILES) {
      throw new HttpException('O catálogo atingiu a capacidade local de 8 GiB ou 10.000 arquivos. Solicite revisão do armazenamento.', HttpStatus.INSUFFICIENT_STORAGE);
    }
  }

  async write(kind: 'roms' | 'covers', buffer: Buffer, console: GameConsole = 'GB'): Promise<CatalogFile> {
    const extension = kind === 'covers' ? 'png' : console === 'GBA' ? 'gba' : 'gb';
    const key = `${randomUUID()}.${extension}`;
    const path = join(this.config.catalogStorageDir, kind, key);
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(buffer);
      await file.sync();
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
    try {
      await file.close();
      const directory = await open(join(this.config.catalogStorageDir, kind), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
    return { kind, key, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
  }

  async removeOwn(file: CatalogFile): Promise<void> {
    await unlink(this.path(file.kind, file.key)).catch(() => undefined);
  }

  async readCover(key: string, expectedSize: number, expectedHash: string): Promise<Buffer> {
    const file = await open(this.path('covers', key), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== expectedSize) throw new Error('Invalid stored cover.');
      const buffer = await file.readFile();
      if (createHash('sha256').update(buffer).digest('hex') !== expectedHash) throw new Error('Invalid stored cover.');
      return buffer;
    } finally { await file.close(); }
  }

  async readRom(key: string, expectedSize: number, expectedHash: string): Promise<Buffer> {
    if (!Number.isInteger(expectedSize) || expectedSize < 192 || expectedSize > 32 * 1024 * 1024) throw new Error('Invalid stored ROM size.');
    const file = await open(this.path('roms', key), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== expectedSize) throw new Error('Invalid stored ROM size.');
      // Allocate exactly the trusted database bound; never read an unbounded file.
      const data = Buffer.allocUnsafe(expectedSize);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
        if (!bytesRead) throw new Error('Incomplete stored ROM.');
        offset += bytesRead;
      }
      if ((await file.stat()).size !== expectedSize || createHash('sha256').update(data).digest('hex') !== expectedHash) throw new Error('Invalid stored ROM integrity.');
      return data;
    } finally { await file.close(); }
  }

  private path(kind: 'roms' | 'covers', key: string) {
    const extension = kind === 'roms' ? '(?:gb|gba)' : 'png';
    if (!new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${extension}$`).test(key)) {
      throw new ServiceUnavailableException('Arquivo do catálogo indisponível.');
    }
    return join(this.config.catalogStorageDir, kind, key);
  }
}
