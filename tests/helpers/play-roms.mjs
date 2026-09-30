import { gbaHeaderChecksum, headerChecksum, syntheticGbaRom, syntheticRom } from './catalog-fixtures.mjs';

// Original, minimal programs generated in memory for real emulator tests.
// No downloaded game, BIOS, external save or binary fixture is needed.
// References for cartridge format, instructions and I/O registers:
// https://gbdev.io/pandocs/CPU_Instruction_Set.html
// https://gbdev.io/pandocs/Joypad_Input.html
// https://gbdev.io/pandocs/MBC1.html
// https://mgba-emu.github.io/gbatek/
// Both programs store [value, 0x53] at the beginning of native cartridge SRAM.
// A writes 1; B writes 0. Boot restores that value before drawing the screen.
export const PLAY_ROM_SAVE_MAGIC = 0x53;

function gbProgram() {
  const bytes = [];
  const labels = new Map();
  const jumps = [];
  const emit = (...opcodes) => bytes.push(...opcodes);
  const label = (name) => labels.set(name, bytes.length);
  const jump = (opcode, target) => {
    emit(opcode, 0);
    jumps.push({ offset: bytes.length - 1, target });
  };

  emit(0xf3, 0x31, 0xfe, 0xff); // di; ld sp,$fffe
  emit(0x3e, 0x0a, 0xea, 0x00, 0x00); // Enable MBC1 external RAM.
  emit(0xfa, 0x01, 0xa0, 0xfe, PLAY_ROM_SAVE_MAGIC); // Existing save marker?
  jump(0x28, 'load'); // jr z,load
  emit(0xaf, 0xea, 0x00, 0xa0); // Initialize saved value to zero.
  emit(0x3e, PLAY_ROM_SAVE_MAGIC, 0xea, 0x01, 0xa0);
  label('load');
  emit(0xfa, 0x00, 0xa0, 0xe6, 0x01, 0x57); // d = saved value & 1
  emit(0xf0, 0x40, 0xcb, 0x7f); // An already-disabled LCD needs no VBlank wait.
  jump(0x28, 'disable');
  label('vblank');
  emit(0xf0, 0x44, 0xfe, 144); // Wait for LY >=144 before disabling LCD.
  jump(0x38, 'vblank');
  label('disable');
  emit(0xaf, 0xe0, 0x40, 0xe0, 0x42, 0xe0, 0x43, 0xe0, 0x26);
  emit(0x21, 0x00, 0x80, 0x01, 0x00, 0x20); // hl=$8000; bc=$2000
  label('clear');
  emit(0xaf, 0x22, 0x0b, 0x78, 0xb1); // Clear tile pixels and maps.
  jump(0x20, 'clear');
  emit(0x7a, 0xb7); // a=d; or a
  jump(0x28, 'light');
  emit(0x3e, 0xe7); // Color 0 maps to darkest shade for saved value1.
  jump(0x18, 'palette');
  label('light');
  emit(0x3e, 0xe4); // Color 0 maps to lightest shade for saved value0.
  label('palette');
  emit(0xe0, 0x47, 0x3e, 0x91, 0xe0, 0x40); // BGP; enable LCD + BG.
  label('poll');
  emit(0x3e, 0x10, 0xe0, 0x00); // Select A/B/Select/Start (active low).
  emit(0xf0, 0x00, 0xf0, 0x00, 0xf0, 0x00); // Let matrix inputs settle.
  emit(0xcb, 0x47); // bit0,a: A
  jump(0x28, 'a');
  emit(0xcb, 0x4f); // bit1,a: B
  jump(0x28, 'b');
  jump(0x18, 'poll');
  label('a');
  emit(0x3e, 0x01, 0xea, 0x00, 0xa0, 0x3e, 0xe7, 0xe0, 0x47);
  jump(0x18, 'poll');
  label('b');
  emit(0xaf, 0xea, 0x00, 0xa0, 0x3e, 0xe4, 0xe0, 0x47);
  jump(0x18, 'poll');

  for (const { offset, target } of jumps) {
    const delta = labels.get(target) - offset - 1;
    if (!Number.isInteger(delta) || delta < -128 || delta > 127) throw new Error('Invalid fixture branch.');
    bytes[offset] = delta & 0xff;
  }
  return Buffer.from(bytes);
}

export function playableGbRom() {
  const rom = syntheticRom({ seed: Buffer.alloc(16) });
  rom.fill(0, 0x134, 0x144);
  rom.write('OWN SRAM TEST', 0x134, 'ascii');
  rom[0x147] = 0x03; // MBC1 + RAM + battery.
  rom[0x149] = 0x02; // 8KiB native SRAM.
  gbProgram().copy(rom, 0x150);
  headerChecksum(rom);
  let checksum = 0;
  for (let offset = 0; offset < rom.length; offset += 1) {
    if (offset !== 0x14e && offset !== 0x14f) checksum = (checksum + rom[offset]) & 0xffff;
  }
  rom.writeUInt16BE(checksum, 0x14e);
  return rom;
}

// ARMv4T instructions verified with GNU binutils arm-none-eabi 2.42.
// Each word has its source mnemonic next to it; no assembler is needed to run
// tests. r8 = SRAM, r9 = saved value. Mode3 framebuffer is solid red for0 and
// green for1. No BIOS calls, IRQ handlers or stack are required.
const gbaProgram = [
  0xe3a0840e, // mov r8,#0x0e000000
  0xe5d80001, // ldrb r0,[r8,#1]
  0xe3500053, // cmp r0,#0x53
  0x1a000003, // bne initialize
  0xe5d89000, // ldrb r9,[r8]
  0xe3590001, // cmp r9,#1
  0x13a09000, // movne r9,#0
  0xea000003, // b display
  0xe3a09000, // initialize: mov r9,#0
  0xe5c89000, // strb r9,[r8]
  0xe3a00053, // mov r0,#0x53
  0xe5c80001, // strb r0,[r8,#1]
  0xe3a00301, // display: mov r0,#0x04000000
  0xe59f1064, // ldr r1,[pc,#100] => literal 0x0403 (mode3 | BG2)
  0xe1c010b0, // strh r1,[r0]
  0xe3a02406, // paint: mov r2,#0x06000000
  0xe3a03c96, // mov r3,#38400 (240 *160)
  0xe3590001, // cmp r9,#1
  0x03a04e3e, // moveq r4,#0x03e0 (green)
  0x13a0401f, // movne r4,#0x001f (red)
  0xe0c240b2, // pixel: strh r4,[r2],#2
  0xe2533001, // subs r3,r3,#1
  0x1afffffc, // bne pixel
  0xe59f1040, // poll: ldr r1,[pc,#64] => KEYINPUT
  0xe1d100b0, // ldrh r0,[r1]
  0xe3100001, // tst r0,#1 (A)
  0x0a000002, // beq press_a
  0xe3100002, // tst r0,#2 (B)
  0x0a000005, // beq press_b
  0xeafffff8, // b poll
  0xe3590001, // press_a: cmp r9,#1
  0x0afffff6, // beq poll
  0xe3a09001, // mov r9,#1
  0xe5c89000, // strb r9,[r8]
  0xeaffffeb, // b paint
  0xe3590000, // press_b: cmp r9,#0
  0x0afffff1, // beq poll
  0xe3a09000, // mov r9,#0
  0xe5c89000, // strb r9,[r8]
  0xeaffffe6, // b paint
  0x00000403, // DISPCNT literal
  0x04000130, // KEYINPUT literal
];

export function playableGbaRom() {
  const rom = syntheticGbaRom({ seed: Buffer.alloc(16) });
  rom.fill(0, 0xa0, 0xac);
  rom.write('OWN SRAM GBA', 0xa0, 'ascii');
  gbaProgram.forEach((instruction, index) => rom.writeUInt32LE(instruction, 0xc0 + index * 4));
  // Conventional cartridge signature lets the real core select native SRAM.
  rom.write('SRAM_V113\0', 0x200, 'ascii');
  return gbaHeaderChecksum(rom);
}

// Same original framebuffer/input program using the Flash command protocol.
// Erase sector0, program value+marker, and poll completion before painting.
// The second 64KiB bank is untouched, allowing restore tests to put a sentinel
// there and detect truncation. References: GBATEK Cart Backup Flash and
// https://github.com/mgba-emu/mgba/blob/master/src/gba/savedata.c
const gbaFlashProgram = [
  // Before reading data: enter/read/exit Flash ID mode, select bank1 then0.
  // These actual hardware commands distinguish Flash1M from plain SRAM and
  // exercise both banks; a signature alone is insufficient for core detection.
  // r8=Flash base, r6=command1, r7=command2.
  0xe3a0840e, 0xe59f6174, 0xe59f7174, 0xe3a00090,
  0xeb000054, 0xe5d80000, 0xe3a000f0, 0xeb000051,
  0xe3a000b0, 0xeb00004f, 0xe3a00001, 0xe5c80000,
  0xe3a000b0, 0xeb00004b, 0xe3a00000, 0xe5c80000,
  // Restore marker/value or initialize.
  0xe5d80001, 0xe3500053, 0x1a000003, 0xe5d89000,
  0xe3590001, 0x13a09000, 0xea000001, 0xe3a09000, 0xeb00001b,
  // Mode3, 240*160 pixels: value1 green, value0 red.
  0xe3a00301, 0xe59f1118, 0xe1c010b0, 0xe3a02406,
  0xe3a03c96, 0xe3590001, 0x03a04e3e, 0x13a0401f,
  0xe0c240b2, 0xe2533001, 0x1afffffc,
  // Poll KEYINPUT; A sets1, B sets0; only changed values erase/program.
  0xe59f10f4, 0xe1d100b0, 0xe3100001, 0x0a000002,
  0xe3100002, 0x0a000005, 0xeafffff8, 0xe3590001,
  0x0afffff6, 0xe3a09001, 0xeb000005, 0xeaffffeb,
  0xe3590000, 0x0afffff1, 0xe3a09000, 0xeb000000, 0xeaffffe6,
  // write_state: [5555]=AA,[2AAA]=55,[5555]=80,AA,55,[0000]=30.
  0xe3a000aa, 0xe5c60000, 0xe3a00055, 0xe5c70000,
  0xe3a00080, 0xe5c60000, 0xe3a000aa, 0xe5c60000,
  0xe3a00055, 0xe5c70000, 0xe3a00030, 0xe5c80000,
  0xe5d80000, 0xe35000ff, 0x1afffffc, // Wait erased byte==FF.
  // [5555]=AA,[2AAA]=55,[5555]=A0,[0000]=r9; wait until equal.
  0xe3a000aa, 0xe5c60000, 0xe3a00055, 0xe5c70000,
  0xe3a000a0, 0xe5c60000, 0xe5c89000, 0xe5d80000,
  0xe1500009, 0x1afffffc,
  // Program marker0x53 at0001; wait until equal; return via lr.
  0xe3a000aa, 0xe5c60000, 0xe3a00055, 0xe5c70000,
  0xe3a000a0, 0xe5c60000, 0xe3a00053, 0xe5c80001,
  0xe5d80001, 0xe3500053, 0x1afffffc, 0xe12fff1e,
  // flash_command(r0): AA at5555,55 at2AAA,command at5555; return.
  0xe3a010aa, 0xe5c61000, 0xe3a01055, 0xe5c71000, 0xe5c60000, 0xe12fff1e,
  // Literal addresses: command ports, DISPCNT and KEYINPUT.
  0x0e005555, 0x0e002aaa, 0x00000403, 0x04000130,
];

export function playableGbaFlashRom() {
  const rom = syntheticGbaRom({ seed: Buffer.alloc(16) });
  rom.fill(0, 0xa0, 0xac);
  rom.write('OWN FLASH1M', 0xa0, 'ascii');
  gbaFlashProgram.forEach((instruction, index) => rom.writeUInt32LE(instruction, 0xc0 + index * 4));
  rom.write('FLASH1M_V103\0', 0x300, 'ascii');
  return gbaHeaderChecksum(rom);
}
