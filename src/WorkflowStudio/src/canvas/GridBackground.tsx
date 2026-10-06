import { useId } from 'react';
import { useStore } from '@xyflow/react';

/**
 * The lit mesh (spec §5.1): soft fine dashed neutral grey lines every 8 px, a barely visible solid
 * line every 32 px and a lit dot where 32 px lines cross, over a soft vignette. No bright dashed
 * 32 px line (removed in the mockup v49 review). The patterns are in world units and follow the
 * viewport, so world (0, 0) is a whole cell and block coordinates coincide with drawn lines. Below
 * 60 % zoom the 8 px tier drops out. Pattern ids come from useId, so two canvases never collide.
 */
export function GridBackground() {
  const [tx, ty, zoom] = useStore((s) => s.transform);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const ids = { minor: `${id}-minor`, tile: `${id}-tile`, major: `${id}-major`, majorOnly: `${id}-majorOnly`, vign: `${id}-vign` };
  const transform = `translate(${tx} ${ty}) scale(${zoom})`;

  return (
    <svg className="react-flow__background" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: -1, pointerEvents: 'none' }} aria-hidden="true">
      <defs>
        <pattern id={ids.minor} width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M0 0H8 M0 8H8 M0 0V8 M8 0V8" fill="none" stroke="rgba(200,208,218,.20)" strokeWidth=".6" strokeDasharray="2 2" />
        </pattern>
        <g id={ids.tile}>
          {/* the barely visible 32 px line; the bright dashed 32 px line was removed in the v49 review */}
          <path d="M0 0H32 M0 32H32 M0 0V32 M32 0V32" fill="none" stroke="rgba(214,220,230,.07)" strokeWidth="2.2" />
          {[[0, 0], [0, 32], [32, 0], [32, 32]].map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.3" fill="rgba(236,240,246,.55)" />)}
        </g>
        <pattern id={ids.major} width="32" height="32" patternUnits="userSpaceOnUse" patternTransform={transform}>
          <rect width="32" height="32" fill={`url(#${ids.minor})`} />
          <use href={`#${ids.tile}`} />
        </pattern>
        <pattern id={ids.majorOnly} width="32" height="32" patternUnits="userSpaceOnUse" patternTransform={transform}>
          <use href={`#${ids.tile}`} />
        </pattern>
        <radialGradient id={ids.vign} cx="50%" cy="45%" r="75%">
          <stop offset="0" stopColor="#0F1D33" stopOpacity=".9" /><stop offset="1" stopColor="#0A1220" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="#0A1220" />
      <rect width="100%" height="100%" fill={`url(#${ids.vign})`} />
      <rect width="100%" height="100%" fill={`url(#${zoom < 0.6 ? ids.majorOnly : ids.major})`} />
    </svg>
  );
}
