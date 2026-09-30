/** Shared by catalog mutations and operational backup/recovery coordination. */
export const CATALOG_LOCK_KEY = 781004;
export const MAX_GB_ROM_BYTES = 8 * 1024 * 1024;
export const MAX_GBA_ROM_BYTES = 32 * 1024 * 1024;
/** Largest accepted individual ROM; format-specific validation still enforces the GB limit. */
export const MAX_ROM_BYTES = MAX_GBA_ROM_BYTES;
export const MAX_COVER_BYTES = 2 * 1024 * 1024;
export const MAX_COVER_PIXELS = 4_000_000;
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_GAMES = 1000;
export const MAX_CATALOG_FILES = 10_000;
export const MAX_MULTIPART_BYTES = MAX_ROM_BYTES + MAX_COVER_BYTES + 64 * 1024;
