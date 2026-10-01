import { useEffect, useRef, useId } from 'react';
import type { ReactNode } from 'react';

export function Icon({ name, size = 20 }: { name: 'game' | 'catalogue' | 'users' | 'lock' | 'exit' | 'arrow' | 'plus' | 'close'; size?: number }) {
  const paths = {
    game: <><path d="M7 7h10a4 4 0 0 1 3.9 3.1l1 5A3.3 3.3 0 0 1 16.4 18L14 16h-4l-2.4 2a3.3 3.3 0 0 1-5.5-2.9l1-5A4 4 0 0 1 7 7Z" /><path d="M6 11v4m-2-2h4m8-1h.01M19 14h.01" /></>,
    catalogue: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M7 4V2m10 2V2M3 9h18m-12 4h6m-6 4h4" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /><circle cx="9" cy="7" r="4" /></>,
    lock: <><rect x="4" y="10" width="16" height="12" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v3" /></>,
    exit: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9" /></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function Brand() {
  return <div className="brand"><span className="brand-icon"><Icon name="game" size={24} /></span><span>Emulador<span className="brand-subtitle">GB + GBA</span></span></div>;
}

export function Alert({ children, kind = 'error' }: { children: ReactNode; kind?: 'error' | 'success' | 'info' }) {
  return <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Loading({ children = 'Carregando…' }: { children?: ReactNode }) {
  return <p className="loading" role="status"><span className="spinner" aria-hidden="true" />{children}</p>;
}

export function PasswordFields({ password, confirmation, onPassword, onConfirmation, prefix, label = 'Nova senha' }: {
  password: string;
  confirmation: string;
  onPassword: (value: string) => void;
  onConfirmation: (value: string) => void;
  prefix: string;
  label?: string;
}) {
  return <>
    <div className="field"><label htmlFor={`${prefix}-password`}>{label}</label><input id={`${prefix}-password`} name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={(event) => onPassword(event.target.value)} aria-describedby={`${prefix}-hint`} /><span id={`${prefix}-hint`} className="field-hint">Use de 12 a 128 caracteres. Prefira uma frase longa e exclusiva.</span></div>
    <div className="field"><label htmlFor={`${prefix}-confirm`}>Confirme a senha</label><input id={`${prefix}-confirm`} name="passwordConfirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={(event) => onConfirmation(event.target.value)} /></div>
  </>;
}

export function Dialog({ title, busy, onDismiss, children }: { title: string; busy: boolean; onDismiss: () => void; children: ReactNode }) {
  const titleId=useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onDismiss(); }}>
    <div className="dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Fechar janela" onClick={onDismiss} disabled={busy}><Icon name="close" /></button></div>
    {children}
  </dialog>;
}
