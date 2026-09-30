import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { createPool } from '../database/database.service.js';
import { BootstrapError, bootstrapFirstMaster, validateBootstrapCredentials } from './bootstrap-common.js';

async function hiddenPrompt(label: string): Promise<string> {
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') { cleanup(); reject(new BootstrapError('Operação cancelada.')); return; }
      if (key.name === 'return' || key.name === 'enter') { cleanup(); resolve(value); return; }
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (!key.ctrl && text && !/[\x00-\x1f\x7f]/.test(text)) {
        value += text;
        if (Array.from(value).length > 128) { cleanup(); reject(new BootstrapError('A senha deve ter no máximo 128 caracteres.')); }
      }
    };
    process.stdin.on('keypress', onKey);
    process.stdin.resume();
    process.stdout.write(label);
  });
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.length !== 2) {
    throw new BootstrapError('Execute este comando em terminal interativo, sem argumentos. A senha é solicitada sem eco.');
  }
  const pool = createPool();
  try {
    const existing = await pool.query("SELECT 1 FROM users WHERE role = 'MASTER' LIMIT 1");
    if (existing.rowCount) throw new BootstrapError('Já existe um master. O bootstrap inicial não altera contas existentes.');
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const username = await readline.question('Nome de usuário do primeiro master (3–32, a-z, 0-9, _): ');
    readline.close();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new BootstrapError('Nome de usuário inválido.');
    // Keep terminal echo disabled between both prompts, including fast multi-line pastes.
    const previousRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    let password: string;
    let confirmation: string;
    try {
      password = await hiddenPrompt('Senha do master (12–128 caracteres, sem eco): ');
      confirmation = await hiddenPrompt('Confirme a senha (sem eco): ');
    } finally {
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
    }
    if (Array.from(password).length < 12 || Array.from(password).length > 128 || password !== confirmation) {
      throw new BootstrapError('As senhas devem coincidir e ter entre 12 e 128 caracteres.');
    }
    const credentials = validateBootstrapCredentials({ username, password });
    try {
      await bootstrapFirstMaster(pool, async () => credentials);
      console.log('Primeiro master criado. Entre pela interface com as credenciais escolhidas.');
    } finally { password = ''; confirmation = ''; credentials.password = ''; }
  } finally { await pool.end(); }
}

try { await main(); } catch (error) {
  console.error(error instanceof BootstrapError ? error.message : 'Bootstrap não concluído. Confira banco, migrações e se o nome está disponível.');
  process.exitCode = 1;
}
