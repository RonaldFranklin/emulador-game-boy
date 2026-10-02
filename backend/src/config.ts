import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface AppConfig {
  origin: string;
  trustedProxyHost?: string;
  host: string;
  port: number;
  secureCookie: boolean;
  sessionTtlHours: number;
  masterTtlHours: number;
  masterIdleMinutes: number;
  mfaEncryptionKey?: Buffer;
  catalogStorageDir: string;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const input = process.env[name];
  const value = input === undefined ? fallback : Number(input);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Configuração inválida: ${name}.`);
  }
  return value;
}

export function readConfig(): AppConfig {
  const origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
    throw new Error('APP_ORIGIN deve conter somente a origem completa, sem caminho ou barra final.');
  }
  const secure = process.env.COOKIE_SECURE ?? 'false';
  if (!['true', 'false'].includes(secure)) throw new Error('COOKIE_SECURE deve ser true ou false.');
  if (parsed.protocol === 'https:' && secure !== 'true') {
    throw new Error('Uma origem HTTPS exige COOKIE_SECURE=true.');
  }
  const catalogStorageDir = process.env.CATALOG_STORAGE_DIR ?? '/data/catalog';
  if (!isAbsolute(catalogStorageDir) || resolve(catalogStorageDir) === '/') {
    throw new Error('CATALOG_STORAGE_DIR deve ser um diretório absoluto específico para o catálogo.');
  }
  const mfaFile=process.env.MFA_ENCRYPTION_KEY_FILE;
  const mfaText=mfaFile?readFileSync(mfaFile,'utf8').trim():undefined;
  if(mfaText!==undefined&&!/^[0-9a-f]{64}$/.test(mfaText))throw new Error('Chave MFA inválida; use arquivo hexadecimal de 32 bytes.');
  return {
    origin,
    mfaEncryptionKey:mfaText?Buffer.from(mfaText,'hex'):undefined,
    masterTtlHours:integer('MASTER_SESSION_TTL_HOURS',8,1,8),
    masterIdleMinutes:integer('MASTER_IDLE_MINUTES',15,1,30),
    trustedProxyHost: process.env.TRUSTED_PROXY_HOST || undefined,
    catalogStorageDir: resolve(catalogStorageDir),
    host: process.env.HOST ?? '0.0.0.0',
    port: integer('PORT', 3001, 1, 65535),
    secureCookie: secure === 'true',
    sessionTtlHours: integer('SESSION_TTL_HOURS', 168, 1, 720),
  };
}

export function databaseConfig() {
  const passwordFile = process.env.PGPASSWORD_FILE;
  const password = passwordFile ? readFileSync(passwordFile, 'utf8').trimEnd() : process.env.PGPASSWORD;
  if (!password) throw new Error('Defina PGPASSWORD_FILE ou PGPASSWORD para acessar o banco.');
  return {
    host: process.env.PGHOST ?? '127.0.0.1',
    port: integer('PGPORT', 5432, 1, 65535),
    database: process.env.PGDATABASE ?? 'emulador',
    user: process.env.PGUSER ?? 'emulador_runtime',
    password,
    max: 12,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    application_name: 'emulador-game-boy',
  };
}
