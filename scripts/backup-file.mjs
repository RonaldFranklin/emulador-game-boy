import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
export async function verifyBackup(path) {
  const expected = (await readFile(`${path}.sha256`, 'utf8')).trim();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('Checksum inválido. Restauração não iniciada.');
}
