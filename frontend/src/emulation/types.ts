export type EmulatorKey = 'a' | 'b' | 'select' | 'start' | 'right' | 'left' | 'up' | 'down' | 'r' | 'l';

export interface Emulator {
  /** Copies only native cartridge memory. Never returns a save state. */
  readNativeSave(): Uint8Array | null;
  setPaused(paused: boolean): void;
  setMuted(muted: boolean): Promise<void>;
  /** Call in a user gesture when the browser has blocked audio. */
  resumeAudio(): Promise<void>;
  input(key: EmulatorKey, pressed: boolean): void;
  destroy(): Promise<void>;
}

export interface EmulatorOptions {
  canvas: HTMLCanvasElement;
  console: 'GB' | 'GBA';
  rom: Uint8Array;
  save: Uint8Array | null;
  onError?: (error: Error) => void;
}

export interface MgbaModule {
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _mgbawasm_init(): void;
  _mgbawasm_set_log_level(level: number): void;
  _mgbawasm_load(rom: number, length: number, bios: number, biosLength: number, platform: number, gbModel: number, skipBios: number): number;
  _mgbawasm_platform(): number;
  _mgbawasm_unload(): void;
  _mgbawasm_run_frame(): void;
  _mgbawasm_frame_counter(): number;
  _mgbawasm_video_width(): number;
  _mgbawasm_video_height(): number;
  _mgbawasm_video_ptr(): number;
  _mgbawasm_framerate_micro(): number;
  _mgbawasm_sample_rate(): number;
  _mgbawasm_read_audio(pointer: number, frames: number): number;
  _mgbawasm_set_keys(keys: number): void;
  _mgbawasm_sram_save(): number;
  _mgbawasm_sram_ptr(): number;
  _mgbawasm_sram_load(pointer: number, length: number): number;
}

export type MgbaFactory = (options: { locateFile: (path: string) => string; print: () => void; printErr: () => void }) => Promise<MgbaModule>;
