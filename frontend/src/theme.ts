import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';
const storageKey = 'emulador-theme';
const validTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark';

function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(storageKey);
    return validTheme(value) ? value : null;
  } catch { return null; }
}

function colorScheme(): MediaQueryList | null {
  try { return window.matchMedia('(prefers-color-scheme: dark)'); }
  catch { return null; }
}

const media = colorScheme();
const systemTheme = (): Theme => media?.matches ? 'dark' : 'light';
let preference = storedTheme();
let current: Theme = preference ?? systemTheme();
const listeners = new Set<() => void>();

function applyTheme(theme: Theme) {
  current = theme;
  document.documentElement.dataset.theme = theme;
  for (const listener of listeners) listener();
}

applyTheme(current);

function systemChanged() {
  if (preference === null) applyTheme(systemTheme());
}

function storageChanged(event: StorageEvent) {
  if (event.key !== storageKey && event.key !== null) return;
  try { if (event.storageArea !== window.localStorage) return; }
  catch { return; }
  preference = validTheme(event.newValue) ? event.newValue : null;
  applyTheme(preference ?? systemTheme());
}

media?.addEventListener?.('change', systemChanged);
window.addEventListener('storage', storageChanged);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    media?.removeEventListener?.('change', systemChanged);
    window.removeEventListener('storage', storageChanged);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => current);
}

export function toggleTheme() {
  preference = current === 'dark' ? 'light' : 'dark';
  // The in-memory choice remains usable through navigation/logout if saving fails.
  applyTheme(preference);
  try { window.localStorage.setItem(storageKey, preference); }
  catch { /* A denied or full storage must not prevent changing the theme. */ }
}
