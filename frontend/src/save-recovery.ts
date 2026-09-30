/** Private pending native saves, scoped to the authenticated user and game.
 * This is recovery storage, never a list of user-selectable save slots. */
export interface PendingSave {
  revision: string;
  userId: string;
  gameId: string;
  baseVersion: number;
  dataBase64: string;
  sha256: string;
  savedAt: string;
  next?: { dataBase64: string; sha256: string };
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('emulador-save-recovery-v1', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('pending');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(new Error('A recuperação local não está disponível neste navegador.'));
    open.onblocked = () => reject(new Error('Feche outras abas para habilitar a recuperação local.'));
  });
}

async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('pending', mode);
      const request = action(tx.objectStore('pending'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(new Error('Não foi possível guardar a recuperação local. Mantenha esta página aberta.'));
    });
  } finally { db.close(); }
}

export async function readRecovery(userId: string, gameId: string): Promise<PendingSave | undefined> {
  const value: unknown = await transaction('readonly', store => store.get(`${userId}:${gameId}`));
  if (value === undefined) return;
  const entry = value as PendingSave;
  if (!entry || entry.userId !== userId || entry.gameId !== gameId ||
      typeof entry.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.revision) ||
      !Number.isSafeInteger(entry.baseVersion) || entry.baseVersion < 0 ||
      typeof entry.dataBase64 !== 'string' || entry.dataBase64.length > 1_398_104 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) || (entry.next &&
        (typeof entry.next.dataBase64 !== 'string' || entry.next.dataBase64.length > 1_398_104 || !/^[a-f0-9]{64}$/.test(entry.next.sha256)))) {
    throw new Error('A cópia local de recuperação está inválida. Ela foi preservada para revisão.');
  }
  return entry;
}

async function changeRecovery(userId: string, gameId: string, expectedRevision: string | undefined, entry?: PendingSave): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      const store = tx.objectStore('pending');
      const key = `${userId}:${gameId}`;
      const read = store.get(key);
      read.onsuccess = () => {
        if (read.result?.revision !== expectedRevision) { tx.abort(); return; }
        if (entry) store.put(entry, key); else store.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('A recuperação local mudou em outra aba ou não pôde ser gravada. O conteúdo existente foi preservado.'));
    });
  } finally { db.close(); }
}

export async function writeRecovery(entry: PendingSave, expectedRevision?: string): Promise<void> {
  await changeRecovery(entry.userId, entry.gameId, expectedRevision, entry);
}

export async function removeRecovery(userId: string, gameId: string, expectedRevision?: string): Promise<void> {
  await changeRecovery(userId, gameId, expectedRevision);
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}

export async function saveHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
