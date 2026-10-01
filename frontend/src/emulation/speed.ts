export const speeds = [1, 2, 3, 5, 10] as const;
export type EmulationSpeed = typeof speeds[number];
export function normalizeSpeed(value: unknown): EmulationSpeed {
  return speeds.includes(value as EmulationSpeed) ? value as EmulationSpeed : 1;
}
