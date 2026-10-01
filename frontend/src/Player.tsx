import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from './api';
import type { Request } from './api';
import type { Game } from './games';
import { ConsoleBadge } from './Games';
import { Alert, Dialog, Loading } from './ui';
import { createEmulator } from './emulation/adapter';
import { PlaySession } from './play-session';

import type { EmulatorKey as Key } from './emulation/types';
import { actions, readPreferences, writePreferences, type PlayerPreferences, type PlayerSize } from './player-preferences';
import { normalizeSpeed, speeds } from './emulation/speed';
import { StateSlots } from './StateSlots';
import type { CartridgeState } from './emulation/state';
import { PlayerControls } from './PlayerControls';
type Emulator = Awaited<ReturnType<typeof createEmulator>>;
interface Manifest { game: { id: string; name: string; console: 'GB' | 'GBA' }; core: string; romUrl: string; save: { version: number; updatedAt: string } | null; }

export function Player({ game, userId, request, onExit }: { game: Game; userId: string; request: Request; onExit: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const screen = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const engine = useRef<Emulator | null>(null);
  const romBytes = useRef<Uint8Array | null>(null);
  const [savesOpen,setSavesOpen]=useState(false);
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
  const [expanded, setExpanded] = useState(false);
  const [moreControls, setMoreControls] = useState(false);
  const maximized = fullscreen || expanded;
  const [status, setStatus] = useState('Aguardando início');
  const [conflict, setConflict] = useState(false);
  const [localCopy, setLocalCopy] = useState(false);
  const [exitReview, setExitReview] = useState(false);
  const [reservation, setReservation] = useState<{ generation: string; expiresAt: string } | null>(null);
  const [takeoverReview, setTakeoverReview] = useState(false);

  const [preferences, setPreferences] = useState(() => readPreferences(userId));
  const [settings, setSettings] = useState(false);
  const settingsFlush = useRef<Promise<void> | null>(null);
  const settingsOpen = useRef(false);
  const resumeAfterSettings = useRef(false);
  const pauseEpoch = useRef(0);
  const held = useRef(new Map<string, Key>());
  const [pressedKeys, setPressedKeys] = useState<Key[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: game.console === 'GB' ? 160 : 240, height: game.console === 'GB' ? 144 : 160 });

  function updatePreferences(next: PlayerPreferences) {
    releaseAll(); setPreferences(next); writePreferences(userId, next);
  }
  function release(source: string) {
    const key = held.current.get(source);
    held.current.delete(source);
    if (key) setPressedKeys([...held.current.values()]);
    if (key && ![...held.current.values()].includes(key)) engine.current?.input(key, false);
  }
  function press(source: string, key: Key) {
    if (frozen.current || settingsOpen.current || held.current.has(source)) return;
    held.current.set(source, key); setPressedKeys([...held.current.values()]); engine.current?.input(key, true);
  }
  function releaseAll() {
    held.current.clear(); setPressedKeys(previous => previous.length ? [] : previous); actions.forEach(key => engine.current?.input(key, false));
  }
  function openSettings() {
    if (busyRef.current) return;
    resumeAfterSettings.current = !frozen.current;
    settingsOpen.current = true; pause(); setSettings(true);
    settingsFlush.current = (async () => { await flushing.current?.catch(() => {}); await flush(); })().catch(fail);
  }
  async function closeSettings() {
    const resume = resumeAfterSettings.current;
    resumeAfterSettings.current = false;
    settingsOpen.current = false; setSettings(false); releaseAll();
    const epoch = pauseEpoch.current;
    if (resume && !error && ready && !document.hidden) {
      try {
        await settingsFlush.current; await sync.current?.renew();
        if (alive.current && epoch === pauseEpoch.current && !settingsOpen.current && !document.hidden) {
          frozen.current = false; engine.current?.setPaused(false); setPaused(false); canvas.current?.focus();
        }
      } catch (reason) { fail(reason); }
    }
  }

  useLayoutEffect(() => {
    const container = stage.current;
    if (!container) return;
    const width = game.console === 'GB' ? 160 : 240, height = game.console === 'GB' ? 144 : 160;
    const size = () => {
      if (!maximized) container.style.height = `${Math.max(272, window.innerHeight - (container.getBoundingClientRect().top + window.scrollY) - 20)}px`;
      else container.style.removeProperty('height');
      const available = Math.min(container.clientWidth / width, container.clientHeight / height);
      const target = preferences.size === 'fit' ? available : { compact: 2, medium: 3, large: 5 }[preferences.size];
      const scale = Math.min(available, target);
      // CSS nearest-neighbor rendering keeps pixels sharp at responsive sizes.
      setCanvasSize({ width: width * scale, height: height * scale });
    };
    const observer = new ResizeObserver(size); observer.observe(container); if (screen.current) observer.observe(screen.current);
    window.addEventListener('resize', size); size();
    return () => { observer.disconnect(); window.removeEventListener('resize', size); };
  }, [game.console, preferences.size, maximized]);

  // Expanded mode is a same-page history entry: Back and Escape restore the layout.
  useEffect(() => {
    if (!expanded) return;
    const marker = crypto.randomUUID();
    history.pushState({ ...history.state, playerExpanded: marker }, '');
    const back = () => { releaseAll(); setExpanded(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !screen.current?.querySelector('dialog[open]')) back();
    };
    window.addEventListener('popstate', back);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('popstate', back);
      document.removeEventListener('keydown', escape);
      if (history.state?.playerExpanded === marker) history.back();
    };
  }, [expanded]);

  useLayoutEffect(() => {
    if (!maximized) { setMoreControls(false); return; }
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const viewport = window.visualViewport;
    const resize = () => {
      screen.current?.style.setProperty('--expanded-height', `${viewport?.height ?? innerHeight}px`);
      screen.current?.style.setProperty('--expanded-width', `${viewport?.width ?? innerWidth}px`);
      screen.current?.style.setProperty('--expanded-top', `${viewport?.offsetTop ?? 0}px`);
      screen.current?.style.setProperty('--expanded-left', `${viewport?.offsetLeft ?? 0}px`);
    };
    resize(); viewport?.addEventListener('resize', resize); viewport?.addEventListener('scroll', resize);
    return () => {
      document.body.style.overflow = previous;
      viewport?.removeEventListener('resize', resize); viewport?.removeEventListener('scroll', resize);
      releaseAll();
    };
  }, [maximized]);

  async function toggleFullscreen() {
    releaseAll();
    if (expanded) { setExpanded(false); return; }
    if (document.fullscreenElement === screen.current) {
      try { await document.exitFullscreen(); }
      catch { setWarning('Não foi possível sair da tela cheia. Tente novamente.'); }
      return;
    }
    try {
      if (!screen.current?.requestFullscreen) throw new Error('Fullscreen unavailable');
      await screen.current.requestFullscreen();
    } catch { if (alive.current) setExpanded(true); }
  }

  function pause() {
    pauseEpoch.current += 1;
    frozen.current = true;
    engine.current?.setPaused(true);
    releaseAll();
    if (alive.current) setPaused(true);
  }

  function fail(reason: unknown) {
    resumeAfterSettings.current = false;
    pause();
    if (started.current && engine.current && sync.current) {
      const session = sync.current;
      try {
        void session.capture(engine.current.readNativeSave(), false)
          .then(() => { if (alive.current) setLocalCopy(session.recoveryStored); }).catch(() => {});
      } catch { /* A failed core may no longer expose readable memory. */ }
    }
    if (!alive.current) return;
    if (sync.current?.leaseLost) { clearInterval(heartbeat.current); clearInterval(poll.current); }
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
      if (document.hidden) resumeAfterSettings.current = false;
      if (document.hidden && engine.current) { pause(); void (async () => { await flushing.current; await flush(); })().catch(fail); }
    };
    const pageHide = () => {
      if (!engine.current) return;
      pause();
      // Best effort local capture only; no unload promise is a durability guarantee.
      try { void sync.current?.capture(engine.current.readNativeSave(), false).catch(fail); } catch (reason) { fail(reason); }
    };
    const pageShow = (event: PageTransitionEvent) => {
      if (event.persisted && engine.current) { pause(); void sync.current?.renew().catch(fail); }
    };
    const blur = () => { releaseAll(); resumeAfterSettings.current = false; pauseEpoch.current += 1; };
    const fullscreenChanged = () => { releaseAll(); setFullscreen(document.fullscreenElement === screen.current); };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!engine.current) return;
      try { if (sync.current?.matchesConfirmed(engine.current.readNativeSave())) return; } catch { /* Keep warning if memory cannot be checked. */ }
      event.preventDefault(); event.returnValue = '';
    };
    document.addEventListener('visibilitychange', hide);
    document.addEventListener('fullscreenchange', fullscreenChanged);
    window.addEventListener('pagehide', pageHide); window.addEventListener('pageshow', pageShow);
    window.addEventListener('blur', blur);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      alive.current = false;
      cancelled.current = true;
      controller.abort();
      clearInterval(poll.current); clearInterval(heartbeat.current);
      document.removeEventListener('visibilitychange', hide);
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      window.removeEventListener('pagehide', pageHide); window.removeEventListener('pageshow', pageShow);
      window.removeEventListener('blur', blur);
      window.removeEventListener('beforeunload', beforeUnload);
      releaseAll();
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
      const source = `keyboard:${event.code}`;
      if (!down) { release(source); return; }
      if (event.ctrlKey || event.altKey || event.metaKey) { releaseAll(); return; }
      if (event.repeat && !held.current.has(source)) return;
      const target = event.target;
      if (settingsOpen.current || frozen.current || event.isComposing ||
        (target instanceof Element && target.closest('input,textarea,select,button,a,dialog,[contenteditable]:not([contenteditable="false"])'))) return;
      const mapped = actions.find(action => preferences.bindings[action].includes(event.code));
      if (!mapped || (game.console === 'GB' && ['l', 'r'].includes(mapped))) return;
      event.preventDefault(); press(source, mapped);
    };
    const down = (event: KeyboardEvent) => key(event, true);
    const up = (event: KeyboardEvent) => key(event, false);
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest('input,textarea,select,button,a,dialog,[contenteditable]')) releaseAll();
    };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('focusin', focus);
    return () => { releaseAll(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('focusin', focus); };
  }, [game.console, preferences.bindings]);

  async function start(expectedGeneration?: string) {
    if (busyRef.current || !manifest || !canvas.current) return;
    busyRef.current = true; setBusy(true); setError(''); setConflict(false); setReservation(null); setTakeoverReview(false);
    try {
      const expected = game.console === 'GB' ? 'mgba-gb-v1' : 'mgba-gba-v1';
      if (manifest.game.console !== game.console || manifest.core !== expected || manifest.romUrl !== `/api/play/${game.id}/rom`) {
        throw new Error('A configuração deste jogo não é compatível com o player. Atualize a biblioteca.');
      }
      setStatus('Restaurando progresso…');
      const session = new PlaySession(userId, game.id, request, text => { if (alive.current) setStatus(text); });
      sync.current = session;
      const saved = await session.acquire(expectedGeneration);
      if (cancelled.current) { await session.release(); return; }
      let leaseFailure: unknown;
      heartbeat.current = setInterval(() => {
        void session.renew().catch(reason => { leaseFailure = reason; fail(reason); });
      }, 30_000);
      setStatus('Carregando ROM e motor…');
      const response = await fetch(manifest.romUrl, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new ApiError(response.status, 'Não foi possível carregar esta ROM. Confira sua sessão e a disponibilidade do jogo.');
      const rom = new Uint8Array(await response.arrayBuffer());
      romBytes.current=rom;
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
      instance.setVolume(preferences.volume);
      await instance.setSpeed(preferences.speed);
      instance.setPaused(false);
      canvas.current.focus();
      poll.current = setInterval(() => { if (!frozen.current) void flush().catch(fail); }, 2000);
    } catch (reason) {
      clearInterval(poll.current); clearInterval(heartbeat.current);
      fail(reason);
      if (engine.current) { await engine.current.destroy(); engine.current = null; }
      await sync.current?.release().catch(() => {});
      if (!sync.current?.conflict && alive.current) {
        try {
          const result = await request<{ reservation: { generation: string; expiresAt: string } | null }>(`/play/${game.id}/lease`, { signal: AbortSignal.timeout(12000) });
          if (alive.current) setReservation(result.reservation);
        } catch { /* Keep the original failure and an ordinary retry. */ }
      }
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
      const epoch = pauseEpoch.current;
      try { await sync.current?.renew(); if (epoch !== pauseEpoch.current || settingsOpen.current || document.hidden || !alive.current) return; frozen.current = false; engine.current?.setPaused(false); setPaused(false); canvas.current?.focus(); }
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

  async function leave(keepLocal = false, confirmed = false) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); pause();
    try {
      await flushing.current?.catch(() => {});
      if (keepLocal) {
        await sync.current?.capture(engine.current?.readNativeSave() ?? null, false);
        if (!sync.current?.recoveryStored) throw new Error('Não há cópia local confirmada. Tente sincronizar antes de sair.');
      } else await flush();
      if (!keepLocal && !confirmed) { setExitReview(true); return; }
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

  async function openSaves() {
    if (busyRef.current) return;
    pause(); settingsOpen.current=true; busyRef.current=true;setBusy(true);
    try {await flushing.current?.catch(()=>{});await flush();setSavesOpen(true);}
    catch(reason){settingsOpen.current=false;fail(reason);}
    finally{busyRef.current=false;setBusy(false);}
  }
  async function captureState(): Promise<CartridgeState> {
    pause(); await flushing.current?.catch(()=>{});await flush();await sync.current!.renew();
    return engine.current!.captureState();
  }
  async function loadState(state:CartridgeState) {
    if (!romBytes.current || !canvas.current || !sync.current || !engine.current) throw new Error('Inicie o jogo antes de carregar.');
    pause(); await flushing.current?.catch(()=>{});await flush();await sync.current.renew();
    if (!state.native.length && sync.current.remote.version) throw new Error('Este ponto não contém memória de cartucho e não pode substituir o save nativo existente. O jogo atual foi preservado.');
    const old=engine.current,ctx=canvas.current.getContext('2d')!,picture=ctx.getImageData(0,0,canvas.current.width,canvas.current.height);
    let candidate:Emulator|null=null;
    try {
      candidate=await createEmulator({canvas:canvas.current,console:game.console,rom:romBytes.current,save:state.native.length?state.native:null,state:state.data,onError:fail});
      await sync.current.renew();
      candidate.setVolume(preferences.volume);await candidate.setSpeed(preferences.speed);await candidate.setMuted(muted);
    }catch(reason){await candidate?.destroy();ctx.putImageData(picture,0,0);throw reason;}
    // A validated replacement remains paused through the native write/ACK.
    // On ambiguous ACK it stays installed: retry can never capture the old RAM.
    engine.current=candidate;await old.destroy();
    try {await sync.current.capture(candidate.readNativeSave(),true,true);setLocalCopy(sync.current.recoveryStored);setError('');}
    catch(reason){fail(reason);throw reason;}
  }

  function touch(key: Key, label: string, text: string) {
    return <button className={`touch-key touch-${key}`} type="button" aria-label={label} data-pressed={pressedKeys.includes(key)} disabled={!ready || paused || settings}
      onContextMenu={event => event.preventDefault()}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); press(`pointer:${event.pointerId}`, key); }}
      onPointerUp={event => release(`pointer:${event.pointerId}`)} onPointerCancel={event => release(`pointer:${event.pointerId}`)}
      onLostPointerCapture={event => release(`pointer:${event.pointerId}`)}
      onKeyDown={event => { if (!event.ctrlKey && !event.altKey && !event.metaKey && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); press(`button:${key}:${event.code}`, key); } }}
      onKeyUp={event => release(`button:${key}:${event.code}`)} onBlur={releaseAll}>{text}</button>;
  }

  return <section ref={screen} className={`player${expanded ? " player-expanded" : ""}${moreControls ? " player-tools-open" : ""}${error || warning || busy ? " player-attention" : ""}`} aria-label={`Jogando ${game.name}`}>
    <div className="page-heading"><div><span className="eyebrow">SEU JOGO</span><h1>{game.name}</h1></div><ConsoleBadge console={game.console} /></div>
    {error && <Alert>{error}</Alert>}
    {warning && <div><Alert kind="info">{warning}</Alert><button className="button quiet" onClick={() => setWarning('')}>Dispensar aviso</button></div>}
    <p className="save-status" role="status" data-testid="save-status">{status}</p>
    {error && ready && <div className="player-actions"><button className="button secondary" onClick={() => void retry()} disabled={busy || conflict}>Tentar sincronizar</button>
      {localCopy && <button className="button secondary" onClick={() => void leave(true)} disabled={busy}>Voltar mantendo cópia local</button>}</div>}
    {!ready && error && !conflict && <div className="player-actions">
      <button className="button secondary" disabled={busy} onClick={() => void start()}>Tentar novamente</button>
      {reservation && <><button className="button secondary" disabled={busy} onClick={() => setTakeoverReview(true)}>Encerrar sessão anterior e jogar aqui</button>
        <p>Você também pode aguardar e tentar novamente. Sem renovação, a reserva expira em {new Date(reservation.expiresAt).toLocaleTimeString('pt-BR')}. Uma reserva não significa que o emulador ainda está executando.</p></>}
    </div>}
    {conflict && !ready && <p><button className="button secondary" disabled={busy} onClick={() => {
      if (window.confirm('Descartar a cópia pendente e as pendências isoladas apresentadas deste jogo nesta conta e usar o servidor? Feche antes a aba antiga. Essas cópias locais não poderão ser recuperadas.')) {
        void sync.current?.discardLocal().then(() => { setConflict(false); setError(''); }).catch(fail);
      }
    }}>Descartar cópia local e usar save do servidor</button></p>}
    {expanded && <p className="expanded-notice" role="status">Tela cheia indisponível. Modo expandido: a interface do navegador permanece.</p>}
    <div className="player-toolbar">
      {maximized && <button className="button secondary" aria-expanded={moreControls} aria-controls="player-tools-panel" onClick={() => { releaseAll(); setMoreControls(!moreControls); }}>{moreControls ? 'Menos controles' : 'Mais controles'}</button>}
      {ready && <>
      <button className="button secondary" onClick={() => void togglePause()} disabled={busy || !!error}>{paused ? 'Retomar' : 'Pausar'}</button>
      <button className="button secondary" onClick={() => void toggleFullscreen()} aria-pressed={maximized}>{maximized ? 'Sair da tela cheia' : 'Tela cheia'}</button>
      </>}
      <div className="player-tools" id="player-tools-panel">
      {maximized && <p className="player-tools-status" role="status">{status}</p>}
      <label className="player-size">Tamanho<select aria-label="Tamanho da tela" value={preferences.size} onChange={event => updatePreferences({ ...preferences, size: event.target.value as PlayerSize })}>
        <option value="compact">Compacto</option><option value="medium">Médio</option><option value="large">Grande</option><option value="fit">Ajustar ao espaço disponível</option>
      </select></label>
      <label className="player-size">Velocidade<select aria-label="Velocidade" value={preferences.speed} disabled={busy} onChange={event => {
        const speed = normalizeSpeed(Number(event.target.value)); updatePreferences({ ...preferences, speed });
        void engine.current?.setSpeed(speed).catch(() => setWarning('O navegador não ativou o áudio. Tente novamente pelo botão de áudio.'));
      }}>{speeds.map(speed => <option key={speed} value={speed}>{speed}×{speed === 1 ? ' (normal)' : ''}</option>)}</select></label>
      {preferences.speed !== 1 && <span className="field-hint" role="status">Áudio temporariamente silenciado durante aceleração.</span>}
      <button className="button secondary" aria-pressed={preferences.showButtons} onClick={() => updatePreferences({ ...preferences, showButtons: !preferences.showButtons })}>Mostrar botões</button>
      <button className="button secondary" aria-label="Configurações" disabled={busy} onClick={openSettings}><span aria-hidden="true">⚙</span> Configurações</button>
    {ready && <div className="player-actions">
      <button className="button secondary" disabled={busy||!!error} onClick={()=>void openSaves()}>Saves</button>
      <label className="player-volume">Volume {preferences.volume}%<input aria-label="Volume" type="range" min="0" max="100" step="1" value={preferences.volume} onChange={event => {
        const volume = Number(event.target.value); updatePreferences({ ...preferences, volume }); engine.current?.setVolume(volume);
      }} /></label>
      <button className="button secondary" onClick={() => void toggleSound()} aria-pressed={!muted}>{muted ? 'Ativar áudio' : 'Silenciar'}</button>
    </div>}
    <button className="button primary" onClick={() => { if (ready) void leave(); else onExit(); }} disabled={busy}>{busy && ready ? 'Sincronizando…' : ready ? 'Salvar e voltar' : 'Voltar à biblioteca'}</button>
      </div>
    </div>
    {!ready && manifest?.save && <p>Existe memória do cartucho no servidor ({new Date(manifest.save.updatedAt).toLocaleString('pt-BR')}). Ela será restaurada automaticamente. Escolha Continue/Continuar no menu do jogo, se houver uma partida gravada.</p>}
    <div ref={stage} className={`player-screen console-${game.console.toLowerCase()}`}>
      <canvas style={{ width: canvasSize.width, height: canvasSize.height }} ref={canvas} aria-label="Tela do jogo" tabIndex={0} width={game.console === 'GB' ? 160 : 240} height={game.console === 'GB' ? 144 : 160} />
      {!ready && <div className="player-start">{busy ? <Loading>Carregando jogo e progresso…</Loading> : <button className="button primary" disabled={!manifest || conflict} onClick={() => void start()}>{manifest?.save ? 'Continuar jogo' : 'Iniciar jogo'}</button>}</div>}
    {preferences.showButtons && <div className="touch-controls" aria-label="Controles de toque">
      {game.console === 'GBA' && <div className="shoulder-controls">{touch('l', 'Botão L', 'L')}{touch('r', 'Botão R', 'R')}</div>}
      <div className="touch-main"><div className="touch-directions">
        <svg className="dpad-shell" viewBox="0 0 144 144" aria-hidden="true" focusable="false">
          <defs><linearGradient id="dpad-face" x2="0" y2="1"><stop stopColor="var(--dpad-top)" /><stop offset="1" stopColor="var(--dpad-bottom)" /></linearGradient></defs>
          <path d="M54 1H90Q95 1 95 6V48H138Q143 48 143 54V90Q143 95 138 95H96V138Q96 143 90 143H54Q48 143 48 138V96H6Q1 96 1 90V54Q1 48 6 48H48V6Q48 1 54 1Z" fill="url(#dpad-face)" stroke="#0c1e13" strokeWidth="2" />
          <path d="M54 3H90M3 54V89M50 7V49H7M98 50H137M50 99V137" fill="none" stroke="#b8d5ad" strokeOpacity=".2" strokeLinecap="round" />
        </svg>{touch('up', 'Direcional cima', '')}{touch('left', 'Direcional esquerda', '')}{touch('right', 'Direcional direita', '')}{touch('down', 'Direcional baixo', '')}<span className="touch-center" aria-hidden="true" /></div>
        <div className="touch-actions">{touch('b', 'Botão B', 'B')}{touch('a', 'Botão A', 'A')}</div></div>
      <div className="touch-system">{touch('select', 'Select', 'Select')}{touch('start', 'Start', 'Start')}</div>
    </div>}
    </div>

    <p className="player-instructions">“Salvar e voltar” sincroniza a memória do cartucho; não salva o instante da tela nem aciona SAVE. No FireRed: Start → SAVE → confirme e aguarde o jogo terminar a gravação. Ao reabrir, escolha CONTINUE no menu do jogo. Bytes sincronizados não garantem uma partida válida. Fechar a aba abruptamente pode perder a última alteração.</p>

    <p className="field-hint"><a href="/emulator/NOTICE.html" target="_blank" rel="noreferrer">Motor e licenças de terceiros</a></p>
    {takeoverReview && reservation && <Dialog title="Assumir este jogo?" busy={busy} onDismiss={() => setTakeoverReview(false)}>
      <p>A outra aba perderá o controle. Progresso ainda não sincronizado nela pode não estar disponível aqui. O save confirmado será restaurado antes de iniciar.</p>
      <div className="player-actions"><button className="button secondary" onClick={() => setTakeoverReview(false)}>Cancelar</button>
      <button className="button primary" onClick={() => void start(reservation.generation)}>Confirmar e jogar aqui</button></div>
    </Dialog>}
    {exitReview && <Dialog title="Sincronização antes de sair" busy={busy} onDismiss={() => setExitReview(false)}>
      <p>{sync.current?.remote.version ? sync.current.confirmation() : 'Sem save confirmado no servidor. Use SAVE no menu do jogo antes de sair.'}</p>
      <p>Sincronizamos somente a memória gravada pelo jogo. Para continuar depois, escolha Continue/Continuar no menu do jogo; não retomamos o instante da tela.</p>
      <div className="player-actions"><button className="button secondary" disabled={busy} onClick={() => setExitReview(false)}>Permanecer no jogo</button>
      <button className="button primary" disabled={busy} onClick={() => void leave(false, true)}>{sync.current?.remote.version ? 'Voltar à biblioteca' : 'Sair sem save confirmado'}</button></div>
    </Dialog>}
    {savesOpen && <StateSlots gameId={game.id} userId={userId} request={request} token={sync.current!.token} capture={captureState} load={loadState} nativeInfo={sync.current?.remote.version?sync.current.confirmation():'Sem save confirmado'} onClose={()=>{setSavesOpen(false);settingsOpen.current=false;releaseAll();}}/>}
    {settings && <PlayerControls bindings={preferences.bindings} onChange={bindings => updatePreferences({ ...preferences, bindings })} onClose={() => void closeSettings()} />}
  </section>;
}
