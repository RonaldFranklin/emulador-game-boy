import { performance } from 'node:perf_hooks';
import { limited } from '../auth/rate-limit.service.js';

/** Single-instance, bounded admission. No queues and no attacker-controlled allocation past cap. */
export class Admission {
  readonly entries = new Map<string, { count: number; until: number }>();
  active = 0;
  loginActive = 0;
  private sweepAt = 0;
  constructor(private readonly now = () => performance.now(), readonly capacity = 4096) {}
  take(key: string, maximum: number, milliseconds: number, cost = 1) {
    const now = this.now();
    if (now >= this.sweepAt) {
      for (const [id, entry] of this.entries) if (entry.until <= now) this.entries.delete(id);
      this.sweepAt = now + 1000;
    }
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      if (!entry && this.entries.size >= this.capacity) throw limited('Serviço ocupado. Tente novamente em instantes.', 1);
      entry = { count: 0, until: now + milliseconds }; this.entries.set(key, entry);
    }
    if (entry.count + cost > maximum) throw limited('Muitas requisições. Aguarde antes de tentar novamente.', (entry.until - now) / 1000);
    entry.count += cost;
  }
  enter(login: boolean) {
    // Reserve capacity for existing sessions; anonymous password work may occupy at most two slots.
    if (this.active >= 32 || (login && this.loginActive >= 2)) throw limited('Serviço ocupado. Tente novamente em instantes.', 1);
    this.active++; if (login) this.loginActive++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; if (login) this.loginActive--; } };
  }
}
