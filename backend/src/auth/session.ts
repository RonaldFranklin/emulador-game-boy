import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { UserRow } from '../users/user.js';

export const SESSION_COOKIE = 'emulador_session';
export const CONFIG = Symbol('APP_CONFIG');

export interface SessionIdentity {
  tokenHash: string;
  csrfToken: string;
  user: UserRow;
}

export interface AuthRequest extends Request { identity: SessionIdentity; }

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const csrfForToken = (token: string) => createHmac('sha256', token).update('emulador-csrf-v1').digest('base64url');

export function sessionToken(request: Request): string | undefined {
  const cookies = (request.headers.cookie ?? '').split(';').map((part) => part.trim());
  const matches = cookies.filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return undefined;
  const token = matches[0]?.slice(SESSION_COOKIE.length + 1);
  return token && /^[a-zA-Z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function csrfMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(provided)) return false;
  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  // timingSafeEqual requires equal byte lengths, not equal string lengths.
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

export function setSessionCookie(response: Response, token: string, config: AppConfig): void {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.secureCookie,
    sameSite: 'strict',
    path: '/api',
    maxAge: config.sessionTtlHours * 3_600_000,
  });
}

export function clearSessionCookie(response: Response, config: AppConfig): void {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: config.secureCookie,
    sameSite: 'strict',
    path: '/api',
  });
}
