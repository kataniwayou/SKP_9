import type { Point } from '../model/geometry';

/** The wire's bezier path and the spot (about 24 px before the target) where its letter pill sits. */
export function wirePath(out: Point, inn: Point): { d: string; pill: Point } {
  const tx = inn.x - 9;
  const dx = Math.max(40, Math.abs(tx - out.x) / 2);
  const d = `M ${out.x} ${out.y} C ${out.x + dx} ${out.y}, ${tx - dx} ${inn.y}, ${tx} ${inn.y}`;
  const t = 1 - 24 / Math.max(48, Math.hypot(tx - out.x, inn.y - out.y));
  const u = 1 - t;
  const x = u ** 3 * out.x + 3 * u * u * t * (out.x + dx) + 3 * u * t * t * (tx - dx) + t ** 3 * tx;
  const y = u ** 3 * out.y + 3 * u * u * t * out.y + 3 * u * t * t * inn.y + t ** 3 * inn.y;
  return { d, pill: { x, y } };
}
