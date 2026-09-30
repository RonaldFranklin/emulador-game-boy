import { spawn } from 'node:child_process';
export function run(args, { input, output, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: [input ?? 'ignore', output ?? 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', data => { stdout += data; });
    child.stderr?.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`Docker falhou (${code}): ${stderr.trim()}`));
      else { if (!quiet && stderr) process.stderr.write(stderr); resolve(stdout.trim()); }
    });
  });
}
export const compose = (...args) => ['compose', ...args];
