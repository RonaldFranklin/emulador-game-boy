import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { MAX_SAVE_BASE64_LENGTH, MAX_SAVE_BYTES } from './play-constants.js';

function object(input: unknown, fields: string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) ||
      Object.keys(input).some((key) => !fields.includes(key))) {
    throw new BadRequestException('Campos de progresso inválidos.');
  }
  return input as Record<string, unknown>;
}

function leaseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) {
    throw new BadRequestException('Identificador da sessão de jogo inválido.');
  }
  return value;
}

export function acquireInput(input: unknown): string | undefined {
  const body = object(input, ['expectedGeneration']);
  if (body.expectedGeneration === undefined) return;
  if (typeof body.expectedGeneration !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedGeneration)) {
    throw new BadRequestException('Geração da reserva inválida.');
  }
  return body.expectedGeneration;
}

export function leaseInput(input: unknown): string {
  return leaseId(object(input, ['leaseId']).leaseId);
}

export function saveInput(input: unknown) {
  const body = object(input, ['leaseId', 'baseVersion', 'dataBase64', 'sha256', 'epoch']);
  const id = leaseId(body.leaseId);
  const epoch = body.epoch == null ? null : leaseId(body.epoch);
  if (typeof body.baseVersion !== 'number' || !Number.isInteger(body.baseVersion) || body.baseVersion < 0 || body.baseVersion > 2147483647) {
    throw new BadRequestException('Versão de progresso inválida.');
  }
  if (typeof body.dataBase64 !== 'string' || body.dataBase64.length === 0) throw new BadRequestException('O progresso nativo não pode ser vazio.');
  if (body.dataBase64.length > MAX_SAVE_BASE64_LENGTH) throw new PayloadTooLargeException('O progresso nativo deve ter no máximo 1 MiB.');
  if (body.sha256 !== undefined && (typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256))) {
    throw new BadRequestException('Checksum de progresso inválido.');
  }
  return { epoch, leaseId: id, baseVersion: body.baseVersion, dataBase64: body.dataBase64, sha256: body.sha256 as string | undefined };
}

/** Called only after transaction-level actor/game/lease authorization. */
export function decodeSave(encoded: string): Buffer {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new BadRequestException('Progresso deve usar base64 válido.');
  const data = Buffer.from(encoded, 'base64');
  if (data.length > MAX_SAVE_BYTES) throw new PayloadTooLargeException('O progresso nativo deve ter no máximo 1 MiB.');
  if (!data.length || data.toString('base64') !== encoded) throw new BadRequestException('Progresso deve usar base64 canônico e não vazio.');
  return data;
}
