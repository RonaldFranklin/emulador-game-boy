import { STATE_CORE } from './state';
import { normalizeSpeed } from './speed';
import type { Emulator, EmulatorKey, EmulatorOptions, MgbaFactory, MgbaModule } from './types';

export type { Emulator, EmulatorKey, EmulatorOptions } from './types';

const ASSET_ROOT = '/emulator/';
const MAX_SAVE_BYTES = 1024 * 1024;
const AUDIO_FRAMES = 4096;
const keyBits: Record<EmulatorKey, number> = {
  a: 1, b: 2, select: 4, start: 8, right: 16, left: 32, up: 64, down: 128, r: 256, l: 512,
};
let binaryPromise: Promise<Uint8Array> | undefined;
let factoryPromise: Promise<MgbaFactory> | undefined;

function loadFactory(): Promise<MgbaFactory> {
  if (factoryPromise) return factoryPromise;
  factoryPromise = new Promise<MgbaFactory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${ASSET_ROOT}mgba.js`;
    script.async = true;
    script.onload = () => {
      const factory = (globalThis as typeof globalThis & { createMgbaModule?: MgbaFactory }).createMgbaModule;
      if (typeof factory === 'function') resolve(factory);
      else reject(new Error('O motor de emulação não pôde ser inicializado.'));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Não foi possível carregar o motor de emulação local.'));
    };
    document.head.append(script);
  }).catch((error: unknown) => {
    factoryPromise = undefined;
    throw error;
  });
  return factoryPromise;
}

function allocate(module: MgbaModule, bytes: Uint8Array): number {
  const pointer = module._malloc(bytes.length);
  if (!pointer) throw new Error('Memória insuficiente para iniciar o jogo.');
  module.HEAPU8.set(bytes, pointer);
  return pointer;
}

/**
 * Each call owns a fresh WASM instance, native save memory and audio context.
 * No SDK, IndexedDB, OPFS, browser cache of ROMs, global inputs or BIOS is used.
 * The returned instance is muted and paused, at frame zero or the supplied
 * state, with native save already attached. The caller owns sync and UI input.
 */
export async function createEmulator(options: EmulatorOptions): Promise<Emulator> {
  const { canvas, console: gameConsole, onError } = options;
  if (!options.rom.byteLength) throw new Error('A ROM recebida está vazia.');
  if (options.save && (!options.save.byteLength || options.save.byteLength > MAX_SAVE_BYTES)) {
    throw new Error('O tamanho do progresso recebido é inválido.');
  }
  const context = canvas.getContext('2d');
  if (!context) throw new Error('O navegador não oferece o desenho necessário para jogar.');
  const factory = await loadFactory();
  binaryPromise ??= (async () => {
    const response = await fetch('/emulator/mgba.wasm');
    if (!response.ok) throw new Error('Motor indisponível.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
    if (`wasm:${digest}` !== STATE_CORE) throw new Error('Identidade do core incompatível. Atualize a aplicação.');
    return bytes;
  })().catch(reason => { binaryPromise=undefined; throw reason; });
  let module: MgbaModule | null = await factory({
    wasmBinary: await binaryPromise,
    locateFile: (path) => `${ASSET_ROOT}${path.split('/').pop()}`,
    print: () => {},
    printErr: () => {},
  });
  let audio: AudioContext | undefined;
  let sink: AudioWorkletNode | undefined;
  let gain: GainNode | undefined;
  let audioPointer = 0;
  let paused = true;
  let muted = true;
  let volume = 0.7;
  let speed = normalizeSpeed(1);
  let destroyed = false;
  let animation = 0;
  let previousTime: number | null = null;
  let accumulated = 0;
  let keys = 0;
  let frameDuration = 1000 / 59.7275;
  let pixels: ImageData | undefined;

  function liveModule(): MgbaModule {
    if (destroyed || !module) throw new Error('Esta sessão de emulação já foi encerrada.');
    return module;
  }

  function clearAudio() {
    sink?.port.postMessage({ clear: true });
    if (gain) gain.gain.value = 0;
  }

  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    paused = true;
    cancelAnimationFrame(animation);
    clearAudio();
    sink?.disconnect();
    sink?.port.close();
    gain?.disconnect();
    const closingAudio = audio;
    audio = undefined;
    sink = undefined;
    gain = undefined;
    if (module) {
      module._mgbawasm_set_keys(0);
      if (audioPointer) module._free(audioPointer);
      module._mgbawasm_unload();
      module = null;
    }
    pixels = undefined;
    context?.clearRect(0, 0, canvas.width, canvas.height);
    if (closingAudio && closingAudio.state !== 'closed') await closingAudio.close();
  }

  function captureState() {
    const core=liveModule();
    if (!paused) throw new Error('Pause antes de capturar estado.');
    const size=core._mgbawasm_state_size();
    if (size !== (gameConsole==='GB' ? 71680 : 397312)) throw new Error('Formato de estado incompatível.');
    const pointer=core._malloc(size);
    if (!pointer) throw new Error('Memória insuficiente para estado.');
    try {
      if (!core._mgbawasm_state_save(pointer)) throw new Error('Não foi possível capturar o estado.');
      return {data:core.HEAPU8.slice(pointer,pointer+size),native:readNativeSave() ?? new Uint8Array()};
    } finally {core._free(pointer);}
  }

  function readNativeSave(): Uint8Array | null {
    const core = liveModule();
    const length = core._mgbawasm_sram_save();
    if (length === 0) return null;
    const pointer = core._mgbawasm_sram_ptr();
    if (length < 0 || length > MAX_SAVE_BYTES || !pointer) {
      throw new Error('O motor retornou um progresso nativo que não pode ser sincronizado.');
    }
    return core.HEAPU8.slice(pointer, pointer + length);
  }

  function renderFrame(core: MgbaModule) {
    const width = core._mgbawasm_video_width();
    const height = core._mgbawasm_video_height();
    if (!pixels || pixels.width !== width || pixels.height !== height) {
      if (width < 1 || height < 1 || width > 256 || height > 224) {
        throw new Error('O motor retornou dimensões de vídeo inválidas.');
      }
      canvas.width = width;
      canvas.height = height;
      pixels = context!.createImageData(width, height);
    }
    const pointer = core._mgbawasm_video_ptr();
    pixels.data.set(core.HEAPU8.subarray(pointer, pointer + width * height * 4));
    context!.putImageData(pixels, 0, 0);
  }

  function drainAudio(core: MgbaModule) {
    for (let batch = 0; batch < 4; batch += 1) {
      const count = core._mgbawasm_read_audio(audioPointer, AUDIO_FRAMES);
      if (count <= 0) return;
      if (!muted && speed === 1 && audio?.state === 'running' && sink) {
        const samples = core.HEAP16.slice(audioPointer / 2, audioPointer / 2 + count * 2);
        sink.port.postMessage({ samples, rate: core._mgbawasm_sample_rate() }, [samples.buffer]);
      }
      if (count < AUDIO_FRAMES) return;
    }
  }

  function tick(now: number) {
    if (paused || destroyed) return;
    try {
      const core = liveModule();
      if (document.hidden) { setPaused(true); return; }
      const elapsed = previousTime === null ? 0 : now - previousTime;
      previousTime = now;
      // A long suspension is not emulated debt. Keep one bounded RAF chain.
      if (elapsed < 0 || elapsed > 100) accumulated = 0;
      else accumulated = Math.min(accumulated + elapsed * speed, frameDuration * 12);
      let frames = 0;
      const began = performance.now();
      while (accumulated >= frameDuration && frames < 12) {
        core._mgbawasm_run_frame();
        drainAudio(core);
        accumulated -= frameDuration;
        frames += 1;
        // Yield even on a slow device; one core frame cannot be preempted.
        if (performance.now() - began >= 8) break;
      }
      // Discard unpaid whole frames rather than growing a catch-up backlog.
      accumulated %= frameDuration;
      if (frames) renderFrame(core);
      animation = requestAnimationFrame(tick);
    } catch (error) {
      setPaused(true);
      onError?.(error instanceof Error ? error : new Error('A emulação foi interrompida.'));
    }
  }

  function setPaused(value: boolean) {
    const core = liveModule();
    if (paused === value) return;
    paused = value;
    cancelAnimationFrame(animation);
    previousTime = null;
    accumulated = 0;
    keys = 0;
    core._mgbawasm_set_keys(0);
    clearAudio();
    if (paused) {
      if (audio?.state === 'running') void audio.suspend().catch(() => {});
    } else {
      if (gain) gain.gain.value = muted || speed !== 1 ? 0 : volume;
      if (!muted && speed === 1) void audio?.resume().catch(() => {});
      animation = requestAnimationFrame(tick);
    }
  }

  async function resumeAudio() {
    liveModule();
    if (audio && !muted && !paused && speed === 1) await audio.resume();
  }

  async function setSpeed(value: number) {
    liveModule();
    const next = normalizeSpeed(value);
    if (speed === next) return;
    speed = next;
    previousTime = null;
    accumulated = 0;
    clearAudio();
    if (speed !== 1) {
      if (audio?.state === 'running') await audio.suspend();
    } else {
      if (gain) gain.gain.value = muted || paused ? 0 : volume;
      await resumeAudio();
    }
  }

  function setVolume(percent: number) {
    if (!Number.isFinite(percent)) return;
    volume = Math.max(0, Math.min(100, percent)) / 100;
    if (gain) gain.gain.value = muted || paused || speed !== 1 ? 0 : volume;
  }

  async function setMuted(value: boolean) {
    liveModule();
    muted = value;
    clearAudio();
    if (gain) gain.gain.value = muted || paused || speed !== 1 ? 0 : volume;
    if (muted) {
      if (audio?.state === 'running') await audio.suspend();
    } else {
      await resumeAudio();
    }
  }

  try {
    module._mgbawasm_init();
    module._mgbawasm_set_log_level(0);
    const romPointer = allocate(module, options.rom);
    const modelPointer = allocate(module, new Uint8Array([68, 77, 71, 0])); // DMG, including dual-compatible GB ROMs.
    let loaded;
    try {
      loaded = module._mgbawasm_load(romPointer, options.rom.length, 0, 0, gameConsole === 'GB' ? 1 : 0, modelPointer, 1);
    } finally {
      module._free(romPointer);
      module._free(modelPointer);
    }
    if (!loaded || module._mgbawasm_platform() !== (gameConsole === 'GB' ? 1 : 0)) {
      throw new Error('O motor não conseguiu iniciar este cartucho.');
    }
    if (options.save) {
      const pointer = allocate(module, options.save);
      try {
        if (!module._mgbawasm_sram_load(pointer, options.save.length)) {
          throw new Error('Não foi possível restaurar o progresso nativo. O jogo não foi iniciado.');
        }
      } finally {
        module._free(pointer);
      }
      const restored = readNativeSave();
      if (!restored || restored.length !== options.save.length || restored.some((value, index) => value !== options.save![index])) {
        throw new Error('A restauração do progresso não foi confirmada. O jogo não foi iniciado.');
      }
    }
    if (module._mgbawasm_frame_counter() !== 0) throw new Error('O motor iniciou antes de preparar o progresso.');
    if (options.state) {
      if (options.state.length !== module._mgbawasm_state_size()) throw new Error('Tamanho de estado incompatível.');
      const pointer=allocate(module, options.state);
      try { if (!module._mgbawasm_state_load(pointer)) throw new Error('Estado corrompido ou incompatível.'); }
      finally {module._free(pointer);}
      module._mgbawasm_set_keys(0);
      const restored=readNativeSave();
      if (options.save && (!restored || restored.length!==options.save.length || restored.some((b,i)=>b!==options.save![i]))) throw new Error('Estado e memória do cartucho divergiram.');
    }
    frameDuration = 1_000_000_000 / module._mgbawasm_framerate_micro();
    audioPointer = module._malloc(AUDIO_FRAMES * 2 * 2);
    if (!audioPointer) throw new Error('Memória insuficiente para o áudio.');
    audio = new AudioContext();
    await audio.suspend();
    await audio.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
    sink = new AudioWorkletNode(audio, 'cartridge-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    gain = audio.createGain();
    gain.gain.value = 0;
    sink.connect(gain).connect(audio.destination);
    canvas.width = module._mgbawasm_video_width();
    canvas.height = module._mgbawasm_video_height();
    canvas.style.imageRendering = 'pixelated';
    context.fillStyle = '#101a16';
    context.fillRect(0, 0, canvas.width, canvas.height);
    return {
      captureState, readNativeSave, setPaused, setSpeed, setVolume, setMuted, resumeAudio, destroy,
      input(key, pressed) {
        const core = liveModule();
        if (paused || (gameConsole === 'GB' && (key === 'l' || key === 'r'))) return;
        keys = pressed ? keys | keyBits[key] : keys & ~keyBits[key];
        core._mgbawasm_set_keys(keys);
      },
    };
  } catch (error) {
    await destroy();
    throw error;
  }
}
