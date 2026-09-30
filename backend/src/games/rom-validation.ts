import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { MAX_GB_ROM_BYTES, MAX_ROM_BYTES } from './catalog-constants.js';
import { matchesGbaLogo, validateGbaHeader } from './gba-validation.js';
import type { GameConsole } from './game.js';

// Pan Docs cartridge header: this is structural admission, not an emulation guarantee.
// https://github.com/gbdev/pandocs/blob/master/src/The_Cartridge_Header.md
const LOGO = Buffer.from('ceed6666cc0d000b03730083000c000d0008111f8889000edccc6ee6ddddd999bbbb67636e0eecccdddc999fbbb9333e', 'hex');
const KNOWN_CARTRIDGES = new Set([
  0x00, 0x01, 0x02, 0x03, 0x05, 0x06, 0x08, 0x09,
  0x0b, 0x0c, 0x0d, 0x0f, 0x10, 0x11, 0x12, 0x13,
  0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x20, 0x22, 0xfc, 0xfd, 0xfe, 0xff,
]);

function validateGbHeader(buffer: Buffer) {
  if (buffer.length > MAX_GB_ROM_BYTES) throw new PayloadTooLargeException('A ROM deve ter no máximo 8 MiB.');
  if (buffer.length < 32 * 1024 || !buffer.subarray(0x104, 0x134).equals(LOGO)) {
    throw new BadRequestException('O arquivo não contém um cabeçalho válido de Game Boy.');
  }
  const cgbFlag = buffer[0x143]!;
  if ((cgbFlag & 0x80) !== 0 && cgbFlag !== 0x80) {
    throw new BadRequestException('ROM exclusiva de Game Boy Color ou com sinalização incompatível com Game Boy.');
  }
  const cartridgeType = buffer[0x147]!;
  const sizeCode = buffer[0x148]!;
  // 0x52–0x54 are deliberately excluded: Pan Docs identifies them as unverified legacy values.
  if (sizeCode > 8 || buffer.length !== 32 * 1024 * (2 ** sizeCode)) {
    throw new BadRequestException('O tamanho da ROM não corresponde ao cabeçalho (32 KiB a 8 MiB).');
  }
  if (!KNOWN_CARTRIDGES.has(cartridgeType) || buffer[0x149]! > 5) {
    throw new BadRequestException('O cabeçalho informa um tipo de cartucho ou RAM não reconhecido.');
  }
  let checksum = 0;
  for (let offset = 0x134; offset <= 0x14c; offset++) checksum = (checksum - buffer[offset]! - 1) & 0xff;
  if (checksum !== buffer[0x14d]) throw new BadRequestException('O checksum do cabeçalho da ROM é inválido.');
  return { cartridgeType, cgbFlag };
}


export interface ValidatedRom {
  console: GameConsole;
  sha256: string;
  size: number;
  cartridgeType: number | null;
  cgbFlag: number | null;
}

export function validateRom(buffer: Buffer, filename: string): ValidatedRom {
  if (buffer.length > MAX_ROM_BYTES) throw new PayloadTooLargeException('A ROM deve ter no máximo 8 MiB para GB ou 32 MiB para GBA.');
  const extension = extname(filename).toLowerCase();
  if (extension !== '.gb' && extension !== '.gba') {
    throw new BadRequestException('Envie uma ROM .gb (Game Boy) ou .gba (Game Boy Advance).');
  }
  const gb = buffer.subarray(0x104, 0x134).equals(LOGO);
  const gba = matchesGbaLogo(buffer);
  if (gb && gba) throw new BadRequestException('O arquivo contém sinais conflitantes de GB e GBA e não pode ser identificado com segurança.');
  if ((gb && extension !== '.gb') || (gba && extension !== '.gba')) {
    throw new BadRequestException('A extensão do arquivo não corresponde ao console identificado no cabeçalho.');
  }
  if (extension === '.gba') {
    validateGbaHeader(buffer);
    return { console: 'GBA', sha256: createHash('sha256').update(buffer).digest('hex'), size: buffer.length, cartridgeType: null, cgbFlag: null };
  }
  const header = validateGbHeader(buffer);
  return { console: 'GB', sha256: createHash('sha256').update(buffer).digest('hex'), size: buffer.length, ...header };
}
