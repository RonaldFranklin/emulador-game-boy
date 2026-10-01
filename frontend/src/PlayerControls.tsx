import { useEffect, useState } from 'react';
import type { EmulatorKey } from './emulation/types';
import { Dialog } from './ui';
import { actions, actionLabels, allowedCode, defaults, keyLabel, type Bindings } from './player-preferences';

export function PlayerControls({ bindings, onChange, onClose }: { bindings: Bindings; onChange: (bindings: Bindings) => void; onClose: () => void }) {
  const [capture, setCapture] = useState<EmulatorKey | null>(null);
  const [conflict, setConflict] = useState<{ action: EmulatorKey; other: EmulatorKey; code: string } | null>(null);
  const [notice, setNotice] = useState('');
  function cancel() { setCapture(null); setConflict(null); setNotice(''); }
  useEffect(() => {
    if (!capture) return;
    const key = (event: KeyboardEvent) => {
      if (event.code === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); return; }
      // Leave essential browser shortcuts and Tab navigation untouched.
      if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.code === 'Tab' || /^F\d+$/.test(event.code)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat) return;
      if (!allowedCode(event.code) || (event.shiftKey && !event.code.startsWith('Shift'))) {
        setNotice('Escolha uma letra, número, seta, Enter, Espaço ou Shift, sem combinar modificadores.'); return;
      }
      const other = actions.find(action => action !== capture && bindings[action].includes(event.code));
      if (other) { setConflict({ action: capture, other, code: event.code }); setCapture(null); return; }
      onChange({ ...bindings, [capture]: [event.code] }); cancel();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [capture, bindings, onChange]);

  return <Dialog title="Configurações" busy={false} onDismiss={onClose}>
    <div className="player-controls-settings">
      <h3>Controles</h3>
      <p className="muted">Selecione uma ação e pressione a nova tecla. L/R são usados somente no GBA.</p>
      <div className="binding-list">{actions.map(action => <button type="button" className="binding-row" key={action}
        aria-label={`Remapear ${actionLabels[action]}`} aria-pressed={capture === action}
        onClick={() => { setCapture(action); setConflict(null); setNotice(''); }}>
        <span>{actionLabels[action]}</span><kbd>{bindings[action].map(keyLabel).join(' / ')}</kbd>
      </button>)}</div>
      {capture && <div role="status" className="capture-notice">Pressione uma tecla para {actionLabels[capture]}. Escape cancela.
        <button className="button secondary" onClick={cancel}>Cancelar captura</button></div>}
      {notice && <p role="alert">{notice}</p>}
      {conflict && <div role="alert" className="binding-conflict">
        <p>{keyLabel(conflict.code)} já está vinculada a {actionLabels[conflict.other]}. Trocar os vínculos de {actionLabels[conflict.action]} e {actionLabels[conflict.other]}?</p>
        <button className="button secondary" onClick={() => {
          onChange({ ...bindings, [conflict.action]: [...bindings[conflict.other]], [conflict.other]: [...bindings[conflict.action]] }); cancel();
        }}>Trocar vínculos</button><button className="button quiet" onClick={cancel}>Cancelar captura</button>
      </div>}
      <div className="dialog-actions"><button className="button secondary" onClick={() => { onChange(defaults().bindings); cancel(); }}>Restaurar padrão</button>
        <button className="button primary" onClick={onClose}>Concluir</button></div>
    </div>
  </Dialog>;
}
