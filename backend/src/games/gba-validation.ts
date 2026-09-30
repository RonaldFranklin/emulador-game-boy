import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { MAX_GBA_ROM_BYTES } from './catalog-constants.js';

// Header layout/checksum: https://mgba-emu.github.io/gbatek/#gbacartridgeheader
// Canonical logo bytes: https://github.com/devkitPro/gba-tools/blob/master/src/gbafix.c
const GBA_LOGO = Buffer.from(
  '24ffae51699aa2213d84820a84e409ad11248b98c0817f21a352be199309ce20' +
  '10464a4af82731ec58c7e83382e3cebf85f4df94ce4b09c194568ac01372a7fc' +
  '9f844d73a3ca9a615897a327fc039876231dc7610304ae56bf38840040a70efd' +
  'ff52fe036f9530f197fbc08560d68025a963be03014e38e2f9a234ffbb3e0344' +
  '780090cb88113a9465c07c6387f03cafd625e48b380aac7221d4f807', 'hex',
);

export function matchesGbaLogo(buffer: Buffer): boolean {
  if (buffer.length < 0xa0) return false;
  for (let offset = 0x04; offset < 0xa0; offset++) {
    // GBATEK permits these variable logo bits for debugging and cartridge key number.
    const mask = offset === 0x9c ? 0x7b : offset === 0x9e ? 0xfc : 0xff;
    if ((buffer[offset]! & mask) !== (GBA_LOGO[offset - 4]! & mask)) return false;
  }
  return true;
}

/** Structural cartridge admission only; does not execute or guarantee compatibility. */
export function validateGbaHeader(buffer: Buffer): void {
  if (buffer.length > MAX_GBA_ROM_BYTES) throw new PayloadTooLargeException('A ROM de Game Boy Advance deve ter no máximo 32 MiB.');
  if (buffer.length < 0xc0) throw new BadRequestException('O cabeçalho de Game Boy Advance está incompleto (mínimo de 192 bytes).');
  if (!matchesGbaLogo(buffer)) throw new BadRequestException('O logo do cabeçalho de Game Boy Advance é inválido.');
  // This catalog accepts the ordinary unit/device layout. The B4=0x80 debugger variant is excluded.
  if (buffer[0xb2] !== 0x96 || buffer[0xb3] !== 0 || buffer[0xb4] !== 0 ||
      buffer.subarray(0xb5, 0xbc).some((value) => value !== 0) || buffer[0xbe] !== 0 || buffer[0xbf] !== 0) {
    throw new BadRequestException('Os campos fixos ou reservados do cabeçalho de Game Boy Advance são inválidos.');
  }
  let checksum = -0x19;
  for (let offset = 0xa0; offset <= 0xbc; offset++) checksum -= buffer[offset]!;
  if ((checksum & 0xff) !== buffer[0xbd]) throw new BadRequestException('O checksum do cabeçalho de Game Boy Advance é inválido.');
}
