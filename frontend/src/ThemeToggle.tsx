import { toggleTheme, useTheme } from './theme';

export function ThemeToggle() {
  const dark = useTheme() === 'dark';
  return <button
    type="button"
    className="theme-toggle"
    aria-label="Tema escuro"
    aria-pressed={dark}
    title={dark ? 'Ativar tema claro' : 'Ativar tema escuro'}
    onClick={toggleTheme}
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dark
        ? <path d="M20.8 13.1A9 9 0 0 1 10.9 3.2 9 9 0 1 0 20.8 13.1Z" />
        : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>}
    </svg>
    <span>Escuro</span>
  </button>;
}
