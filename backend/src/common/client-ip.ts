import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Request } from 'express';

export function normalizeIp(value: string): string {
  if (!isIP(value) || value.includes('%')) throw new Error('Endereço IP inválido.');
  if (isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return canonical;
}

/** Only the explicitly configured Docker service may supply one sanitized IP. */
export async function clientIp(request: Request, trustedProxyHost?: string): Promise<string> {
  const peer = normalizeIp(request.socket.remoteAddress ?? '');
  if (!trustedProxyHost) return peer;
  // Resolve afresh: recreating the frontend must not leave trust on its old address.
  const addresses = await lookup(trustedProxyHost, { all: true });
  if (!addresses.some(({ address }) => normalizeIp(address) === peer)) return peer;
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') throw new Error('IP encaminhado ausente.');
  return normalizeIp(forwarded);
}
