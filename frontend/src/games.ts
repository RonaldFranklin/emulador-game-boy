import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from './api';
import type { Request } from './api';

export type GameConsole = 'GB' | 'GBA';
export const consoleNames: Record<GameConsole, string> = { GB: 'Game Boy', GBA: 'Game Boy Advance' };

export interface Game {
  id: string;
  name: string;
  console: GameConsole;
  active: boolean;
  hasCover: boolean;
  coverUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export function useGames(request: Request) {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    request<{ games: Game[] }>('/games', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setGames(result.games); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const saveGame = useCallback((game: Game) => {
    setGames((current) => current.some((item) => item.id === game.id)
      ? current.map((item) => item.id === game.id ? game : item)
      : [...current, game]);
  }, []);
  return { games, loading, error, reload, saveGame };
}

export function coverSource(game: Game): string | null {
  if (!game.hasCover || !game.coverUrl) return null;
  const expectedPath = `/api/games/${encodeURIComponent(game.id)}/cover`;
  // Covers always use the private, same-origin endpoint and the session cookie.
  if (game.coverUrl !== expectedPath) return null;
  return `${expectedPath}?v=${encodeURIComponent(game.updatedAt)}`;
}

export const romHint = 'Arquivos descompactados: GB (.gb), de 32 KiB a 8 MiB; GBA (.gba), de 192 bytes a 32 MiB. Jogos exclusivos de Game Boy Color não são aceitos.';
export const coverHint = 'PNG ou JPEG, até 2 MiB, até 2048 px por lado e no máximo 4 megapixels.';

export function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || Array.from(trimmed).length > 120 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error('Informe um nome de 1 a 120 caracteres, sem caracteres de controle.');
  }
  return trimmed;
}

// Header signatures only: the file is never executed. The server repeats these
// checks against the complete upload and is authoritative for admission.
// GB: gbdev/pandocs, The_Cartridge_Header.md. GBA: devkitPro/gba-tools, gbafix.c.
const signature = (hex: string) => Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
const gbLogo = signature('ceed6666cc0d000b03730083000c000d0008111f8889000edccc6ee6ddddd999bbbb67636e0eecccdddc999fbbb9333e');
const gbaLogo = signature('24ffae51699aa2213d84820a84e409ad11248b98c0817f21a352be199309ce2010464a4af82731ec58c7e83382e3cebf85f4df94ce4b09c194568ac01372a7fc9f844d73a3ca9a615897a327fc039876231dc7610304ae56bf38840040a70efdff52fe036f9530f197fbc08560d68025a963be03014e38e2f9a234ffbb3e0344780090cb88113a9465c07c6387f03cafd625e48b380aac7221d4f807');

function hasLogo(header: Uint8Array, logo: Uint8Array, start: number, gba = false): boolean {
  if (header.length < start + logo.length) return false;
  return logo.every((byte, index) => {
    const offset = start + index;
    // GBA permits these documented logo flag bits to vary.
    const mask = gba && offset === 0x9c ? 0x7b : gba && offset === 0x9e ? 0xfc : 0xff;
    return (header[offset]! & mask) === (byte & mask);
  });
}

export async function validateRom(file: File | undefined): Promise<GameConsole> {
  if (!file) throw new Error('Selecione a ROM do jogo.');
  const extension = /\.(gb|gba)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (!extension) throw new Error('Selecione um arquivo .gb ou .gba descompactado. Arquivos ZIP e outros consoles não são aceitos.');
  if (file.size < 192 || file.size > 32 * 1024 * 1024) throw new Error('A ROM deve ter de 192 bytes a 32 MiB; arquivos GB exigem de 32 KiB a 8 MiB.');
  let header: Uint8Array;
  try { header = new Uint8Array(await file.slice(0, 0x150).arrayBuffer()); }
  catch { throw new Error('Não foi possível ler o cabeçalho da ROM. Selecione o arquivo novamente.'); }
  const gb = hasLogo(header, gbLogo, 0x104);
  const gba = hasLogo(header, gbaLogo, 0x04, true);
  if (gb && gba) throw new Error('O arquivo contém cabeçalhos de consoles diferentes e não pode ser identificado com segurança.');
  if (!gb && !gba) throw new Error('O cabeçalho não identifica uma ROM válida de Game Boy ou Game Boy Advance.');
  const detected: GameConsole = gb ? 'GB' : 'GBA';
  if (extension !== detected.toLowerCase()) throw new Error(`O cabeçalho identifica ${consoleNames[detected]}, mas a extensão não corresponde. Use um arquivo .${detected.toLowerCase()}.`);

  if (gb) {
    if (file.size < 32 * 1024 || file.size > 8 * 1024 * 1024) throw new Error('A ROM de Game Boy deve ter entre 32 KiB e 8 MiB.');
    const cgb = header[0x143]!;
    if ((cgb & 0x80) !== 0 && cgb !== 0x80) throw new Error('Jogos exclusivos de Game Boy Color não são aceitos.');
    const sizeCode = header[0x148]!;
    if (sizeCode > 8 || file.size !== 32 * 1024 * (2 ** sizeCode)) throw new Error('O tamanho da ROM de Game Boy não corresponde ao cabeçalho.');
    let checksum = 0;
    for (let offset = 0x134; offset <= 0x14c; offset++) checksum = (checksum - header[offset]! - 1) & 0xff;
    if (checksum !== header[0x14d]) throw new Error('O checksum do cabeçalho da ROM de Game Boy é inválido.');
  } else {
    if (header[0xb2] !== 0x96 || header[0xb3] !== 0 || header[0xb4] !== 0 ||
      header.subarray(0xb5, 0xbc).some((byte) => byte !== 0) || header[0xbe] !== 0 || header[0xbf] !== 0) {
      throw new Error('Os campos fixos do cabeçalho de Game Boy Advance são inválidos.');
    }
    let checksum = -0x19;
    for (let offset = 0xa0; offset <= 0xbc; offset++) checksum -= header[offset]!;
    if ((checksum & 0xff) !== header[0xbd]) throw new Error('O checksum do cabeçalho da ROM de Game Boy Advance é inválido.');
  }
  return detected;
}

export async function validateCover(file: File | undefined): Promise<void> {
  if (!file) return;
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('A capa deve ser uma imagem PNG ou JPEG.');
  if (file.size === 0 || file.size > 2 * 1024 * 1024) throw new Error('A capa deve ter conteúdo e ocupar no máximo 2 MiB.');
  const source = URL.createObjectURL(file);
  try {
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('Não foi possível ler a capa. Escolha uma imagem PNG ou JPEG válida.'));
      image.src = source;
    });
    if (dimensions.width > 2048 || dimensions.height > 2048 || dimensions.width * dimensions.height > 4_000_000) {
      throw new Error('A capa deve ter até 2048 px por lado e no máximo 4 megapixels.');
    }
  } finally {
    URL.revokeObjectURL(source);
  }
}
