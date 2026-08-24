export function normalizedCoordinateScale(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : 1;
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
