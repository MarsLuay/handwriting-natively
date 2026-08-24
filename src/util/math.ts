export function normalizedCoordinateScale(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : 1;
}
