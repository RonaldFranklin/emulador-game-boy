import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import sharp from 'sharp';
import { MAX_COVER_BYTES, MAX_COVER_PIXELS } from './catalog-constants.js';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function rejectAnimatedPng(buffer: Buffer): void {
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length - offset - 12) throw new BadRequestException('A imagem PNG está incompleta.');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) throw new BadRequestException('Capas animadas não são aceitas.');
    offset += length + 12;
    if (type === 'IEND') break;
  }
}

export async function validateCover(buffer: Buffer): Promise<Buffer> {
  if (buffer.length > MAX_COVER_BYTES) throw new PayloadTooLargeException('A capa deve ter no máximo 2 MiB.');
  const png = buffer.subarray(0, 8).equals(PNG_SIGNATURE);
  const jpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (!png && !jpeg) throw new BadRequestException('Envie uma capa PNG ou JPEG válida.');
  if (png) rejectAnimatedPng(buffer);
  try {
    const options = { limitInputPixels: MAX_COVER_PIXELS, failOn: 'warning' as const, sequentialRead: true };
    const metadata = await sharp(buffer, options).timeout({ seconds: 5 }).metadata();
    if (!['png', 'jpeg'].includes(metadata.format ?? '') || !metadata.width || !metadata.height ||
        metadata.width > 2048 || metadata.height > 2048 || metadata.width * metadata.height > MAX_COVER_PIXELS ||
        (metadata.pages ?? 1) !== 1) {
      throw new BadRequestException('A capa deve ser estática, ter até 2048 × 2048 e no máximo 4 milhões de pixels.');
    }
    // Decode fully and re-encode; metadata, original bytes and original filename are discarded.
    const encoded = await sharp(buffer, options).timeout({ seconds: 5 }).rotate().png({ compressionLevel: 9 }).toBuffer();
    if (encoded.length > MAX_COVER_BYTES) throw new PayloadTooLargeException('A capa PNG processada ultrapassa 2 MiB. Escolha uma imagem menor.');
    return encoded;
  } catch (error) {
    if (error instanceof BadRequestException || error instanceof PayloadTooLargeException) throw error;
    throw new BadRequestException('Não foi possível validar a capa. Use PNG ou JPEG íntegro, até 2048 × 2048 e 4 milhões de pixels.');
  }
}
