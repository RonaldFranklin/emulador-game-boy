import { useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from './api';
import type { Request } from './api';
import type { Game } from './games';
import { ConsoleBadge } from './Games';
import { Alert, Loading } from './ui';
import { createEmulator } from './emulation/adapter';
import { PlaySession } from './play-session';

type Emulator = Awaited<ReturnType<typeof createEmulator>>;
type Key = 'a' | 'b' | 'start' | 'select' | 'up' | 'down' | 'left' | 'right' | 'l' | 'r';
interface Manifest { game: { id: string; name: string; console: 'GB' | 'GBA' }; core: string; romUrl: string; }
const keys: Record<string, Key> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyX: 'a', KeyZ: 'b', Enter: 'start', ShiftLeft: 'select', ShiftRight: 'select', KeyQ: 'l', KeyW: 'r' };

export function Player({ game, userId, request, onExit }: { game: Game; userId: string; request: Request; onExit: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const screen = useRef<HTMLElement>(null);
  const engine = useRef<Emulator | null>(null);
  const sync = useRef<PlaySession | null>(null);
  const alive = useRef(true);
  const frozen = useRef(true);
  const started = useRef(false);
  const busyRef = useRef(false);
  const cancelled = useRef(false);
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const heartbeat = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const flushing = useRef<Promise<void> | null>(null);
  const [manifest, setManifest] = useState<Manifest>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(true);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [status, setStatus] = useState('Aguardando início');
  const [conflict, setConflict] = useState(false);
  const [localCopy, setLocalCopy] = useState(false);

  function pause() {
    frozen.current = true;
    engine.current?.setPaused(true);
    Object.values(keys).forEach(key => engine.current?.input(key, false));
    if (alive.current) setPaused(true);
  }

  function fail(reason: unknown) {
    pause();
    if (started.current && engine.current && sync.current) {
      const session = sync.current;
      try {
        void session.capture(engine.current.readNativeSave(), false)
          .then(() => { if (alive.current) setLocalCopy(session.recoveryStored); }).catch(() => {});
      } catch { /* A failed core may no longer expose readable memory. */ }
    }
    if (!alive.current) return;
    setError(errorMessage(reason));
    setStatus('Pendente — jogo pausado; confira a mensagem');
    setConflict(sync.current?.conflict ?? false);
    setLocalCopy(sync.current?.recoveryStored ?? false);
  }

  function flush(): Promise<void> {
    if (flushing.current) return flushing.current;
    if (!engine.current || !sync.current) return Promise.resolve();
    const session = sync.current;
    const job = session.capture(engine.current.readNativeSave())
      .then(() => { if (alive.current) setLocalCopy(session.recoveryStored); })
      .finally(() => { flushing.current = null; });
    flushing.current = job;
    return job;
  }

  useEffect(() => {
    alive.current = true;
    cancelled.current = false;
    const controller = new AbortController();
    request<Manifest>(`/play/${game.id}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) })
      .then(data => { if (!controller.signal.aborted) setManifest(data); })
      .catch(reason => { if (!controller.signal.aborted) fail(reason); });
    const hide = () => {
      if (document.hidden && engine.current) { pause(); void (async () => { await flushing.current; await flush(); })().catch(fail); }
    };
    const blur = () => { Object.values(keys).forEach(key => engine.current?.input(key, false)); };
    const fullscreenChanged = () => setFullscreen(document.fullscreenElement === screen.current);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (engine.current) { event.preventDefault(); event.returnValue = ''; }
    };
    document.addEventListener('visibilitychange', hide);
    document.addEventListener('fullscreenchange', fullscreenChanged);
    window.addEventListener('blur', blur);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      alive.current = false;
      cancelled.current = true;
      controller.abort();
      clearInterval(poll.current); clearInterval(heartbeat.current);
      document.removeEventListener('visibilitychange', hide);
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      window.removeEventListener('blur', blur);
      window.removeEventListener('beforeunload', beforeUnload);
      const currentEngine = engine.current, currentSync = sync.current;
      engine.current = null;
      if (currentEngine) {
        currentEngine.setPaused(true);
        // Last local snapshot is best effort. Periodic/explicit confirmation is
        // the primary path; navigation/unload cannot guarantee async completion.
        try {
          if (started.current) void currentSync?.capture(currentEngine.readNativeSave(), false).catch(() => {});
        } catch { /* Keep cleanup independent of a failed core. */ }
        void currentEngine.destroy();
      }
      void currentSync?.release().catch(() => {});
    };
    // Instances live for this game/user. request remains stable during the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, userId, request]);

  useEffect(() => {
    const key = (event: KeyboardEvent, down: boolean) => {
      const target = event.target as HTMLElement;
      const mapped = keys[event.code];
      if (!mapped || (game.console === 'GB' && ['l', 'r'].includes(mapped))) return;
      // Always release a mapped key, even if focus moved to a toolbar button.
      if (!down) { engine.current?.input(mapped, false); return; }
      if (target.closest('input,textarea,select,button,a') || frozen.current) return;
      event.preventDefault(); engine.current?.input(mapped, down);
    };
    const down = (event: KeyboardEvent) => key(event, true);
    const up = (event: KeyboardEvent) => key(event, false);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [game.console]);

  async function start() {
    if (busyRef.current || !manifest || !canvas.current) return;
    busyRef.current = true; setBusy(true); setError(''); setConflict(false);
    try {
      const expected = game.console === 'GB' ? 'mgba-gb-v1' : 'mgba-gba-v1';
      if (manifest.game.console !== game.console || manifest.core !== expected || manifest.romUrl !== `/api/play/${game.id}/rom`) {
        throw new Error('A configuração deste jogo não é compatível com o player. Atualize a biblioteca.');
      }
      setStatus('Restaurando progresso…');
      const session = new PlaySession(userId, game.id, request, text => { if (alive.current) setStatus(text); });
      sync.current = session;
      const saved = await session.acquire();
      if (cancelled.current) { await session.release(); return; }
      let leaseFailure: unknown;
      heartbeat.current = setInterval(() => {
        void session.renew().catch(reason => { leaseFailure = reason; fail(reason); });
      }, 30_000);
      setStatus('Carregando ROM e motor…');
      const response = await fetch(manifest.romUrl, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new ApiError(response.status, 'Não foi possível carregar esta ROM. Confira sua sessão e a disponibilidade do jogo.');
      const rom = new Uint8Array(await response.arrayBuffer());
      if (cancelled.current) { await session.release(); return; }
      if (leaseFailure) throw leaseFailure;
      const instance = await createEmulator({ canvas: canvas.current, console: game.console, rom, save: saved, onError: fail });
      if (cancelled.current) { await instance.destroy(); await session.release(); return; }
      engine.current = instance;
      if (leaseFailure) throw leaseFailure;
      await session.baseline(instance.readNativeSave());
      await session.renew();
      if (cancelled.current) { await instance.destroy(); await session.release(); return; }
      started.current = true;
      setReady(true); setPaused(false); frozen.current = false;
      instance.setPaused(false);
      canvas.current.focus();
      poll.current = setInterval(() => { if (!frozen.current) void flush().catch(fail); }, 2000);
    } catch (reason) {
      clearInterval(poll.current); clearInterval(heartbeat.current);
      fail(reason);
      if (engine.current) { await engine.current.destroy(); engine.current = null; }
      await sync.current?.release().catch(() => {});
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function retry() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await sync.current?.renew(); await flush(); setConflict(false); }
    catch (reason) { fail(reason); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }

  async function togglePause() {
    if (paused) {
      try { await sync.current?.renew(); frozen.current = false; engine.current?.setPaused(false); setPaused(false); canvas.current?.focus(); }
      catch (reason) { fail(reason); }
    } else {
      pause();
      // A previous PUT may contain an older snapshot. Capture the now-paused
      // cartridge after it settles, before claiming the current progress saved.
      try { await flushing.current?.catch(() => {}); await flush(); }
      catch (reason) { fail(reason); }
    }
  }

  async function toggleSound() {
    setWarning('');
    try { await engine.current?.setMuted(!muted); setMuted(!muted); }
    catch { setWarning('O navegador não ativou o áudio. Tente novamente pelo botão de áudio.'); }
  }

  async function leave(keepLocal = false) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); pause();
    try {
      await flushing.current?.catch(() => {});
      if (keepLocal) {
        await sync.current?.capture(engine.current?.readNativeSave() ?? null, false);
        if (!sync.current?.recoveryStored) throw new Error('Não há cópia local confirmada. Tente sincronizar antes de sair.');
      } else await flush();
      // Progress is already confirmed above (remotely or explicitly locally).
      // A deactivated game/network failure may prevent release; its lease will
      // expire. That must not trap the user in an otherwise safely closed game.
      await sync.current?.release().catch(() => {});
      clearInterval(poll.current); clearInterval(heartbeat.current);
      const instance = engine.current; engine.current = null;
      await instance?.destroy();
      onExit();
    } catch (reason) { fail(reason); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }

  function touch(key: Key, label: string, text: string) {
    return <button className={`touch-key touch-${key}`} type="button" aria-label={label} disabled={!ready || paused}
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); engine.current?.input(key, true); }}
      onPointerUp={() => engine.current?.input(key, false)} onPointerCancel={() => engine.current?.input(key, false)}
      onLostPointerCapture={() => engine.current?.input(key, false)}
      onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); engine.current?.input(key, true); } }}
      onKeyUp={() => engine.current?.input(key, false)} onBlur={() => engine.current?.input(key, false)}>{text}</button>;
  }

  return <section ref={screen} className="player" aria-label={`Jogando ${game.name}`}>
    <div className="page-heading"><div><span className="eyebrow">SEU JOGO</span><h1>{game.name}</h1></div><ConsoleBadge console={game.console} /></div>
    {error && <Alert>{error}</Alert>}
    {warning && <div><Alert kind="info">{warning}</Alert><button className="button quiet" onClick={() => setWarning('')}>Dispensar aviso</button></div>}
    <p className="save-status" role="status" data-testid="save-status">{status}</p>
    {error && ready && <div className="player-actions"><button className="button secondary" onClick={() => void retry()} disabled={busy || conflict}>Tentar sincronizar</button>
      {localCopy && <button className="button secondary" onClick={() => void leave(true)} disabled={busy}>Voltar mantendo cópia local</button>}</div>}
    {conflict && !ready && <p><button className="button secondary" disabled={busy} onClick={() => {
      if (window.confirm('Descartar somente a cópia local pendente deste jogo e usar o progresso do servidor? Essa cópia local não poderá ser recuperada.')) {
        void sync.current?.discardLocal().then(() => { setConflict(false); setError(''); }).catch(fail);
      }
    }}>Descartar cópia local e usar save do servidor</button></p>}
    <div className={`player-screen console-${game.console.toLowerCase()}`}>
      <canvas ref={canvas} aria-label="Tela do jogo" tabIndex={0} width={game.console === 'GB' ? 160 : 240} height={game.console === 'GB' ? 144 : 160} />
      {!ready && <div className="player-start">{busy ? <Loading>Carregando jogo e progresso…</Loading> : <button className="button primary" disabled={!manifest || conflict} onClick={() => void start()}>Iniciar jogo</button>}</div>}
    </div>
    {ready && <div className="player-actions">
      <button className="button secondary" onClick={() => void togglePause()} disabled={busy || !!error}>{paused ? 'Retomar' : 'Pausar'}</button>
      <button className="button secondary" onClick={() => void toggleSound()} aria-pressed={!muted}>{muted ? 'Ativar áudio' : 'Silenciar'}</button>
      <button className="button secondary" onClick={() => {
        setWarning('');
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => setWarning('Não foi possível sair da tela cheia. Tente novamente.'));
        else if (!screen.current?.requestFullscreen) setWarning('Tela cheia não está disponível neste navegador.');
        else void screen.current.requestFullscreen().catch(() => setWarning('Tela cheia não está disponível neste navegador.'));
      }} aria-pressed={fullscreen}>{fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}</button>
    </div>}
    <div className="touch-controls" aria-label="Controles de toque">
      {game.console === 'GBA' && <div className="shoulder-controls">{touch('l', 'Botão L', 'L')}{touch('r', 'Botão R', 'R')}</div>}
      <div className="touch-main"><div className="touch-directions">{touch('up', 'Direcional cima', '↑')}{touch('left', 'Direcional esquerda', '←')}{touch('down', 'Direcional baixo', '↓')}{touch('right', 'Direcional direita', '→')}</div>
        <div className="touch-actions">{touch('b', 'Botão B', 'B')}{touch('a', 'Botão A', 'A')}</div></div>
      <div className="touch-system">{touch('select', 'Select', 'Select')}{touch('start', 'Start', 'Start')}</div>
    </div>
    <p className="player-instructions">Teclado: setas para mover, X = A, Z = B, Enter = Start e Shift = Select.{game.console === 'GBA' && ' Q = L e W = R.'} Toque nos botões em telas móveis. Ative o áudio pelo botão acima.</p>
    <p className="player-instructions">Use a opção de salvar dentro do jogo. Sincronizamos o save do cartucho; o ponto exato da tela não é salvo. Aguarde “Salvo no servidor” antes de sair. Fechar a aba abruptamente pode perder a última alteração.</p>
    <button className="button primary" onClick={() => { if (ready) void leave(); else onExit(); }} disabled={busy}>{ready ? 'Salvar e voltar' : 'Voltar à biblioteca'}</button>
    <p className="field-hint"><a href="/emulator/NOTICE.html" target="_blank" rel="noreferrer">Motor e licenças de terceiros</a></p>
  </section>;
}
