import { ApiError } from './api';
import type { Request } from './api';
import { fromBase64, readRecovery, removeRecovery, saveHash, toBase64, writeRecovery } from './save-recovery';
import type { PendingSave } from './save-recovery';

export interface RemoteSave { dataBase64: string | null; sha256: string | null; version: number; updatedAt: string | null; }
interface Lease { leaseId: string; expiresAt: string; save: RemoteSave; }

/** One serialized writer. The server lease and revision remain authoritative. */
export class PlaySession {
  private leaseId = '';
  private version = 0;
  private observedHash: string | null = null;
  private confirmedHash: string | null = null;
  private pending?: PendingSave;
  private serial: Promise<void> = Promise.resolve();
  private nextWriteAt = 0;
  conflict = false;
  recoveryStored = false;
  remote: RemoteSave = { dataBase64: null, sha256: null, version: 0, updatedAt: null };

  readonly userId: string;
  readonly gameId: string;
  private request: Request;
  private status: (text: string) => void;
  constructor(userId: string, gameId: string, request: Request, status: (text: string) => void) {
    this.userId = userId; this.gameId = gameId; this.request = request; this.status = status;
  }

  private path(suffix: string) { return `/play/${this.gameId}/${suffix}`; }

  async acquire(): Promise<Uint8Array | null> {
    const lease = await this.request<Lease>(this.path('lease'), { method: 'POST', signal: AbortSignal.timeout(12000) });
    this.leaseId = lease.leaseId;
    this.remote = lease.save;
    this.version = lease.save.version;
    this.confirmedHash = lease.save.sha256;
    this.nextWriteAt = performance.now() + 1100;
    // Validate the server snapshot before acknowledging/removing any good local
    // recovery. A corrupted response must never destroy that independent copy.
    if (!Number.isSafeInteger(this.version) || this.version < 0 ||
        (this.version === 0 && (lease.save.dataBase64 !== null || lease.save.sha256 !== null)) ||
        (this.version > 0 && (typeof lease.save.dataBase64 !== 'string' || !lease.save.dataBase64.length ||
          lease.save.dataBase64.length > 1_398_104 || !/^[a-f0-9]{64}$/.test(lease.save.sha256 ?? '')))) {
      throw new Error('O save recebido está inválido. A cópia local foi preservada.');
    }
    if (lease.save.dataBase64 && await saveHash(fromBase64(lease.save.dataBase64)) !== lease.save.sha256) {
      throw new Error('O save recebido falhou na verificação de integridade. A cópia local foi preservada.');
    }
    this.pending = await readRecovery(this.userId, this.gameId);
    if (this.pending) {
      this.recoveryStored = true;
      if (await saveHash(fromBase64(this.pending.dataBase64)) !== this.pending.sha256) {
        throw new Error('A cópia local tem integridade inválida. O save remoto não foi alterado.');
      }
      if (this.pending.next && await saveHash(fromBase64(this.pending.next.dataBase64)) !== this.pending.next.sha256) {
        throw new Error('A cópia local sucessora tem integridade inválida. O save remoto não foi alterado.');
      }
      if (this.pending.sha256 === this.confirmedHash) {
        if (this.pending.next && this.version > this.pending.baseVersion + 1) {
          this.conflict = true;
          throw new Error('O servidor recebeu outras versões enquanto havia progresso local pendente. Nenhuma versão foi sobrescrita.');
        }
        await this.advancePending();
        if (this.pending) await this.commit();
      }
      else if (this.pending.baseVersion === this.version) {
        await this.commit();
      } else {
        this.conflict = true;
        throw new Error('Há progresso local pendente e outra versão no servidor. Nenhum deles foi sobrescrito.');
      }
    }
    const restored = this.remote.dataBase64 ? fromBase64(this.remote.dataBase64) : null;
    if (restored && await saveHash(restored) !== this.remote.sha256) throw new Error('O save recebido falhou na verificação de integridade.');
    return restored;
  }

  async discardLocal(): Promise<void> {
    await this.clearPending();
    this.conflict = false;
  }

  async baseline(bytes: Uint8Array | null): Promise<void> {
    // The adapter restored the cartridge before its first frame. Initial memory
    // (including default erased SRAM) is observed, never uploaded as a new save.
    this.observedHash = bytes?.length ? await saveHash(bytes) : null;
    if (this.remote.dataBase64 && this.observedHash !== this.remote.sha256) {
      throw new Error('O motor não restaurou o save corretamente. O jogo não foi iniciado.');
    }
    this.status(this.version ? 'Salvo no servidor' : 'Pronto — use a função de salvar do jogo');
  }

  capture(bytes: Uint8Array | null, send = true): Promise<void> {
    // Queue copied memory snapshots, ensuring old responses cannot erase newer work.
    const snapshot = bytes?.slice() ?? null;
    const operation = this.serial.then(async () => {
      if (snapshot?.length && !snapshot.every(byte => byte === 0xff) && !snapshot.every(byte => byte === 0)) {
        if (snapshot.length > 1048576) throw new Error('O save ultrapassa o limite de 1 MiB.');
        const hash = await saveHash(snapshot);
        if (hash !== this.observedHash) {
          const previousRevision = this.pending?.revision;
          const pending: PendingSave = this.pending
            ? { ...this.pending, revision: crypto.randomUUID(), next: { dataBase64: toBase64(snapshot), sha256: hash } }
            : { revision: crypto.randomUUID(), userId: this.userId, gameId: this.gameId, baseVersion: this.version,
              dataBase64: toBase64(snapshot), sha256: hash, savedAt: new Date().toISOString() };
          this.recoveryStored = false;
          this.status('Pendente — guardando cópia local');
          await writeRecovery(pending, previousRevision);
          this.pending = pending;
          this.recoveryStored = true;
          this.observedHash = hash;
        }
      }
      if (send && this.pending && this.conflict) throw new Error('O progresso está em conflito e não foi confirmado no servidor. A cópia local foi preservada.');
      if (send && this.pending) await this.commit();
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  private async commit(): Promise<void> {
    if (!this.pending) return;
    const pending = this.pending;
    this.status('Salvando no servidor…');
    try {
      const delay = this.nextWriteAt - performance.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      const result = await this.request<{ save: Omit<RemoteSave, 'dataBase64'> }>(this.path('save'), {
        method: 'PUT', signal: AbortSignal.timeout(12000), body: { leaseId: this.leaseId, baseVersion: pending.baseVersion,
          dataBase64: pending.dataBase64, sha256: pending.sha256 },
      });
      if (result.save.sha256 !== pending.sha256) throw new Error('A confirmação do servidor diverge do progresso enviado.');
      this.version = result.save.version;
      this.confirmedHash = result.save.sha256;
      this.nextWriteAt = performance.now() + 1100;
      this.remote = { ...result.save, dataBase64: pending.dataBase64 };
      await this.advancePending();
      if (this.pending) {
        // The previous attempt may have committed despite a lost response.
        // Retry it unchanged first, then promote the successor to the confirmed revision.
        await this.commit();
        return;
      }
      this.status('Salvo no servidor');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) this.conflict = true;
      this.status('Pendente — envio não confirmado');
      throw error;
    }
  }

  private async advancePending(): Promise<void> {
    if (!this.pending?.next) { await this.clearPending(); return; }
    const previous = this.pending;
    const next: PendingSave = { revision: crypto.randomUUID(), userId: this.userId, gameId: this.gameId, baseVersion: this.version,
      ...previous.next!, savedAt: new Date().toISOString() };
    await writeRecovery(next, previous.revision);
    this.pending = next;
  }

  private async clearPending(): Promise<void> {
    await removeRecovery(this.userId, this.gameId, this.pending?.revision);
    this.pending = undefined;
    this.recoveryStored = false;
  }

  async renew(): Promise<void> {
    if (!this.leaseId) return;
    await this.request(this.path('lease/renew'), { method: 'POST', signal: AbortSignal.timeout(12000), body: { leaseId: this.leaseId } });
  }

  async release(): Promise<void> {
    await this.serial;
    if (!this.leaseId) return;
    await this.request(this.path('lease'), { method: 'DELETE', signal: AbortSignal.timeout(12000), body: { leaseId: this.leaseId } });
    this.leaseId = '';
  }
}
