/** Private pending native saves, scoped to the authenticated user and game.
 * This is recovery storage, never a list of user-selectable save slots. */
export interface PendingSave {
  epoch?: string | null;
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

async function changeRecovery(userId: string, gameId: string, expectedRevision: string | undefined, entry?: PendingSave, owner?: string): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      const store = tx.objectStore('pending');
      const key = `${userId}:${gameId}`;
      let ownershipLost = false;
      const check = store.get(`owner:${key}`);
      check.onsuccess = () => {
        if (!owner || check.result !== owner) { ownershipLost = true; tx.abort(); return; }
        const read = store.get(key);
        read.onsuccess = () => {
          if (read.result?.revision !== expectedRevision) { tx.abort(); return; }
          if (entry) store.put(entry, key); else store.delete(key);
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(ownershipLost ? new RecoveryOwnershipError() : new Error('A recuperação local mudou em outra aba ou não pôde ser gravada. O conteúdo existente foi preservado.'));
    });
  } finally { db.close(); }
}

export async function writeRecovery(entry: PendingSave, expectedRevision: string | undefined, owner: string): Promise<void> {
  await changeRecovery(entry.userId, entry.gameId, expectedRevision, entry, owner);
}

export async function removeRecovery(userId: string, gameId: string, expectedRevision: string | undefined, owner: string): Promise<void> {
  await changeRecovery(userId, gameId, expectedRevision, undefined, owner);
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

// Ownership fences use the existing object store, so no IndexedDB upgrade is
// needed while an older tab holds it open. The owner is a digest, not a lease token.
export class RecoveryOwnershipError extends Error {
  constructor() { super('Outra instância assumiu a recuperação local. O conteúdo existente foi preservado.'); }
}
export async function recoveryOwner(userId: string, gameId: string): Promise<string | undefined> {
  return transaction('readonly', store => store.get(`owner:${userId}:${gameId}`));
}
export async function claimRecovery(userId: string, gameId: string, owner: string, expected: string | undefined): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite'), store = tx.objectStore('pending');
      const key = `owner:${userId}:${gameId}`, read = store.get(key);
      read.onsuccess = () => {
        if (read.result !== expected) { tx.abort(); return; }
        store.put(owner, key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new RecoveryOwnershipError());
    });
  } finally { db.close(); }
}
export interface IsolatedSave extends PendingSave { archiveId: string; }
export async function isolateRecovery(entry: PendingSave, owner: string): Promise<void> {
  const archiveId = `isolated:${entry.userId}:${entry.gameId}:${owner}`;
  await transaction('readwrite', store => store.put({ ...entry, archiveId }, archiveId));
}
export async function readIsolated(userId: string, gameId: string): Promise<IsolatedSave[]> {
  const prefix = `isolated:${userId}:${gameId}:`;
  const entries: IsolatedSave[] = await transaction('readonly', store => store.getAll(IDBKeyRange.bound(prefix, prefix + '\uffff')));
  if (entries.some(entry => !entry || entry.userId !== userId || entry.gameId !== gameId ||
      typeof entry.archiveId !== 'string' || !entry.archiveId.startsWith(prefix) ||
      !/^[a-f0-9]{64}$/.test(entry.archiveId.slice(prefix.length)) ||
      typeof entry.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.revision))) {
    throw new Error('A pendência isolada está inválida e foi preservada para revisão.');
  }
  return entries;
}
export async function discardIsolated(entries: IsolatedSave[]): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite'), store = tx.objectStore('pending');
      for (const entry of entries) {
        const read = store.get(entry.archiveId);
        read.onsuccess = () => {
          if (read.result?.revision !== entry.revision) { tx.abort(); return; }
          store.delete(entry.archiveId);
        };
      }
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('A pendência isolada mudou. Reabra o jogo para conferir; nada novo foi descartado.'));
    });
  } finally { db.close(); }
}
