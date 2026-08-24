export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function clamp01Safe(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
}
