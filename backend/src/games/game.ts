export type GameConsole = 'GB' | 'GBA';

export interface GameRow {
  id: string;
  name: string;
  console: GameConsole;
  active: boolean;
  rom_key: string;
  rom_sha256: string;
  rom_size: number;
  cartridge_type: number | null;
  cgb_flag: number | null;
  cover_key: string | null;
  cover_sha256: string | null;
  cover_size: number | null;
  created_at: Date;
  updated_at: Date;
}

export function publicGame(game: GameRow) {
  return {
    id: game.id,
    name: game.name,
    console: game.console,
    active: game.active,
    hasCover: game.cover_key !== null,
    coverUrl: game.cover_key ? `/api/games/${game.id}/cover` : null,
    createdAt: game.created_at.toISOString(),
    updatedAt: game.updated_at.toISOString(),
  };
}
