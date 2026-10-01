import { normalizeSpeed, type EmulationSpeed } from './emulation/speed';
import type { EmulatorKey } from './emulation/types';

export const actions: EmulatorKey[] = ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select', 'l', 'r'];
export const actionLabels: Record<EmulatorKey, string> = { up: 'Cima', down: 'Baixo', left: 'Esquerda', right: 'Direita', a: 'A', b: 'B', start: 'Start', select: 'Select', l: 'L', r: 'R' };
export type Bindings = Record<EmulatorKey, string[]>;
export type PlayerSize = 'compact' | 'medium' | 'large' | 'fit';
export interface PlayerPreferences { version: 1; speed: EmulationSpeed; volume: number; size: PlayerSize; showButtons: boolean; bindings: Bindings; }
export const preferenceKey = (userId: string) => `emulador-player-v1:${userId}`;
export function defaults(): PlayerPreferences {
  return { version: 1, speed: 1, volume: 70, size: 'fit', showButtons: true, bindings: {
    up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
    a: ['KeyX'], b: ['KeyZ'], start: ['Enter'], select: ['ShiftLeft', 'ShiftRight'], l: ['KeyQ'], r: ['KeyW'],
  } };
}

// Physical keys only. Browser navigation/modifiers/function keys cannot be bound.
export const allowedCode = (code: string) => /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|Arrow(Up|Down|Left|Right)|Enter|Space|ShiftLeft|ShiftRight)$/.test(code);
export function keyLabel(code: string): string {
  const names: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Espaço', ShiftLeft: 'Shift esq.', ShiftRight: 'Shift dir.', Enter: 'Enter' };
  return names[code] ?? code.replace(/^Key|^Digit/, '').replace('Numpad', 'Num ');
}
export function readPreferences(userId: string): PlayerPreferences {
  try {
    const raw = localStorage.getItem(preferenceKey(userId));
    if (!raw || raw.length > 4096) return defaults();
    const value = JSON.parse(raw) as PlayerPreferences;
    if (value?.version !== 1 || !['compact', 'medium', 'large', 'fit'].includes(value.size) || typeof value.showButtons !== 'boolean') return defaults();
    const seen = new Set<string>();
    const bindings = {} as Bindings;
    for (const action of actions) {
      const codes = value.bindings?.[action];
      if (!Array.isArray(codes) || codes.length < 1 || codes.length > 2) return defaults();
      for (const code of codes) {
        if (typeof code !== 'string' || !allowedCode(code) || seen.has(code)) return defaults();
        seen.add(code);
      }
      bindings[action] = [...codes];
    }
    // Do not carry arbitrary extra stored fields back into application state.
    return { version: 1, speed: normalizeSpeed(value.speed), volume: Number.isInteger(value.volume) && value.volume >= 0 && value.volume <= 100 ? value.volume : 70, size: value.size, showButtons: value.showButtons, bindings };
  } catch { return defaults(); }
}
export function writePreferences(userId: string, value: PlayerPreferences): void {
  try { localStorage.setItem(preferenceKey(userId), JSON.stringify(value)); } catch { /* Keep this player's in-memory choice. */ }
}
