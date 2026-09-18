export function average(values: number[] | null): number {
  return Math.trunc(values!.reduce((sum, value) => sum + value, 0) / values!.length);
}
