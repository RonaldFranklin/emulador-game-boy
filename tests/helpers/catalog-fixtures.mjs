import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

// Header-only synthetic cartridge, generated in memory. It contains no game,
// commercial ROM, save data, or runnable emulator fixture stored in the repo.
const logo = Buffer.from('ceed6666cc0d000b03730083000c000d0008111f8889000edccc6ee6ddddd999bbbb67636e0eecccdddc999fbbb9333e', 'hex');
// Canonical format bytes documented by devkitPro's GBA header tool:
// https://github.com/devkitPro/gba-tools/blob/master/src/gbafix.c
const gbaLogo = Buffer.from([
  '24ffae51699aa2213d84820a84e409ad', '11248b98c0817f21a352be199309ce20',
  '10464a4af82731ec58c7e83382e3cebf', '85f4df94ce4b09c194568ac01372a7fc',
  '9f844d73a3ca9a615897a327fc039876', '231dc7610304ae56bf38840040a70efd',
  'ff52fe036f9530f197fbc08560d68025', 'a963be03014e38e2f9a234ffbb3e0344',
  '780090cb88113a9465c07c6387f03caf', 'd625e48b380aac7221d4f807',
].join(''), 'hex');

export function headerChecksum(bytes) {
  let checksum = 0;
  for (let offset = 0x134; offset <= 0x14c; offset += 1) checksum = (checksum - bytes[offset] - 1) & 0xff;
  bytes[0x14d] = checksum;
  return bytes;
}

export function syntheticRom({ size = 32 * 1024, cgbFlag = 0, seed = randomBytes(16) } = {}) {
  const bytes = Buffer.alloc(size);
  bytes.set([0x00, 0xc3, 0x50, 0x01], 0x100);
  logo.copy(bytes, 0x104);
  bytes.write('SYNTHETIC TEST', 0x134, 'ascii');
  bytes[0x143] = cgbFlag;
  bytes[0x147] = size === 32 * 1024 ? 0x00 : 0x19;
  bytes[0x148] = Math.log2(size / (32 * 1024));
  bytes[0x149] = 0;
  bytes[0x14a] = 1;
  bytes.set([0x18, 0xfe], 0x150);
  seed.copy(bytes, 0x160);
  headerChecksum(bytes);
  let total = 0;
  for (let offset = 0; offset < bytes.length; offset += 1) {
    if (offset !== 0x14e && offset !== 0x14f) total = (total + bytes[offset]) & 0xffff;
  }
  bytes.writeUInt16BE(total, 0x14e);
  return bytes;
}

export function gbaHeaderChecksum(bytes) {
  let complement = -0x19;
  for (let offset = 0xa0; offset <= 0xbc; offset += 1) complement -= bytes[offset];
  bytes[0xbd] = complement & 0xff;
  return bytes;
}

export function syntheticGbaRom({ size = 256 * 1024, seed = randomBytes(16) } = {}) {
  if (!Number.isInteger(size) || size < 192) throw new Error('A fixture GBA precisa comportar o cabeçalho completo.');
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(0xea00002e, 0);
  gbaLogo.copy(bytes, 4);
  bytes.write(`TEST${seed.toString('hex').slice(0, 8)}`, 0xa0, 'ascii');
  bytes.write('TST0', 0xac, 'ascii');
  bytes.write('01', 0xb0, 'ascii');
  bytes[0xb2] = 0x96;
  if (size >= 0xc4) bytes.writeUInt32LE(0xeafffffe, 0xc0);
  if (size >= 0xc4 + seed.length) seed.copy(bytes, 0xc4);
  return gbaHeaderChecksum(bytes);
}

export async function syntheticCover({ width = 64, height = 96, format = 'png', background = '#50764a' } = {}) {
  const image = sharp({ create: { width, height, channels: 3, background } });
  return format === 'jpeg' ? image.jpeg().toBuffer() : image.png().toBuffer();
}
