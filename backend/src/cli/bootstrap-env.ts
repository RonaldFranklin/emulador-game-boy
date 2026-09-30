import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import type { Pool } from 'pg';
import { BootstrapError, bootstrapFirstMaster, type BootstrapResult } from './bootstrap-common.js';

export const DEFAULT_BOOTSTRAP_ENV_FILE = '/run/secrets/bootstrap_env';
const MAX_ENV_BYTES = 64 * 1024;

/** Restrict only bootstrap assignments to the common literal subset of Node/Compose dotenv. */
export function parseBootstrapEnv(content: string) {
  const declared: Partial<Record<'ADMIN_USERNAME' | 'ADMIN_PASSWORD', string>> = {};
  for (const line of content.split(/\r?\n/)) {
    const assignment = /^[ \t]*(?:export[ \t]+)?(ADMIN_USERNAME|ADMIN_PASSWORD)[ \t]*=/.exec(line);
    if (!assignment) continue;
    const key = assignment[1] as 'ADMIN_USERNAME' | 'ADMIN_PASSWORD';
    if (Object.hasOwn(declared, key)) throw new BootstrapError('Não repita ADMIN_USERNAME ou ADMIN_PASSWORD no arquivo .env.');
    const value = line.slice(assignment[0].length);
    const quoted = /^[ \t]*'([^'\r\n]*)'[ \t]*(?:#[^\r\n]*)?$/.exec(value);
    if (quoted && !quoted[1]!.endsWith('\\')) { declared[key] = quoted[1]!; continue; }
    if (key === 'ADMIN_USERNAME') {
      const plain = /^[ \t]*([a-z0-9_]*)[ \t]*(?:#[^\r\n]*)?$/.exec(value);
      if (plain) { declared[key] = plain[1]!; continue; }
      throw new BootstrapError('ADMIN_USERNAME deve ocupar uma linha, sem aspas ou entre aspas simples, usando somente a-z, 0-9 ou _.');
    }
    throw new BootstrapError('ADMIN_PASSWORD deve ocupar uma linha entre aspas simples, sem apóstrofo interno, quebra de linha ou barra invertida final. Para senha com apóstrofo ou barra invertida final, use o bootstrap interativo.');
  }
  let values: ReturnType<typeof parseEnv>;
  try { values = parseEnv(content); }
  catch { throw new BootstrapError('O arquivo .env do bootstrap possui formato inválido.'); }
  // In particular, do not accept a value truncated by a mismatched quote or an
  // ADMIN assignment swallowed into another multiline variable by the parser.
  if (values.ADMIN_USERNAME !== declared.ADMIN_USERNAME || values.ADMIN_PASSWORD !== declared.ADMIN_PASSWORD) {
    throw new BootstrapError('As credenciais do bootstrap precisam usar atribuições literais completas em linhas separadas.');
  }
  if (!values.ADMIN_USERNAME || !values.ADMIN_PASSWORD) {
    throw new BootstrapError('Configure ADMIN_USERNAME e ADMIN_PASSWORD no arquivo .env para criar o primeiro master.');
  }
  return { username: values.ADMIN_USERNAME, password: values.ADMIN_PASSWORD };
}

async function credentialsFromFile(path: string) {
  let content: string;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_ENV_BYTES) throw new Error('Invalid environment file.');
      // A bounded read also rejects a file which grows after stat, without unbounded allocation.
      const buffer = Buffer.alloc(MAX_ENV_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > MAX_ENV_BYTES) throw new Error('Environment file exceeds limit.');
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    } finally { await file.close(); }
  } catch {
    throw new BootstrapError('Não foi possível ler o arquivo .env do bootstrap. Use um arquivo UTF-8 regular de até 64 KiB.');
  }
  // parseEnv returns data only: no process.env changes, expansion or shell evaluation.
  return parseBootstrapEnv(content);
}

/** Existing masters make this a no-op before any file access or credential validation. */
export function bootstrapMasterFromEnv(pool: Pool, envFile = DEFAULT_BOOTSTRAP_ENV_FILE): Promise<BootstrapResult> {
  return bootstrapFirstMaster(pool, () => credentialsFromFile(envFile), 'skip');
}
