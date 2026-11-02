import { useStore } from '@xyflow/react';
import { FAR_ZOOM, farFontSize, type FarText } from '../farLabels';

/**
 * Whether the canvas is zoomed out past the far view's threshold; a node re-renders only when it crosses it. A canvas
 * with no size yet (not laid out) has no zoom worth judging: it is drawn near.
 */
export const useFar = (): boolean => useStore((s) => s.width > 0 && s.transform[2] < FAR_ZOOM);

/** One far name, its lines centred on `cy` (world px), each line a font height apart. */
function FarName({ t, cy, className }: { t: FarText; cy: number; className?: string }) {
  const size = farFontSize(t);
  const n = t.lines.length;
  return (
    <text className={className} x={0} y={cy} style={{ fontSize: size }}>
      {t.lines.map((line, i) => (
        // the line height follows the font: 1.1em per line, the block centred on cy
        <tspan key={i} x={0} dy={i === 0 ? `${-((n - 1) * 1.1) / 2}em` : '1.1em'}>{line}</tspan>
      ))}
    </text>
  );
}

/**
 * The far view of a block (canvas/farLabels.ts): a dark plate over the inner `w` × `h` art at (`x`, `y`), and its names
 * centred on it: the main one in the upper part (or the middle, alone), the second one under it.
 */
export function FarPlate({ x, y, w, h, main, second }: { x: number; y: number; w: number; h: number; main: FarText; second?: FarText | null }) {
  const cx = x + w / 2;
  const mainY = second ? y + h * 0.4 : y + h / 2;
  return (
    <g className="nx-far" aria-hidden="true" transform={`translate(${cx} 0)`}>
      <rect className="far-plate" x={x - cx} y={y} width={w} height={h} rx={6} />
      <FarName t={main} cy={mainY} />
      {second && <FarName t={second} cy={y + h * 0.82} className="far-proc" />}
    </g>
  );
}
