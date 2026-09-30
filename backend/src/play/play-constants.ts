export const MAX_SAVE_BYTES = 1024 * 1024;
export const MAX_SAVE_BASE64_LENGTH = 4 * Math.ceil(MAX_SAVE_BYTES / 3);
export const MAX_SAVE_JSON_BYTES = 1536 * 1024;
export const MAX_SAVES_BYTES = 1024 * 1024 * 1024;
export const MAX_SAVES = 10_000;
export const LEASE_TTL_SECONDS = 120;
export const LEASE_RENEW_SECONDS = 30;

// The console is persisted with the immutable ROM; clients cannot select a core.
// Kept separate from database identity so a future tested adapter can be migrated.
export const CORE_FOR_CONSOLE = { GB: 'mgba-gb-v1', GBA: 'mgba-gba-v1' } as const;
