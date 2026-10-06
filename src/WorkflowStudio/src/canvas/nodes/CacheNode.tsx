import { Fragment } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CACHE_H, CACHE_W } from '../../layout/geometry';
import type { FittedText } from '../fitText';
import { CACHE_FRAME, CACHE_FRAME_IN, hexPoints } from './nxShapes';

export type CacheNodeData = {
  /** The name, wrapped at `-`, `_` and `.` onto one or two lines, each fitted to the frame. */
  lines: string[];
  /** `CACHE · v<version>`, fitted to the frame with its letter spacing; the tooltip keeps the full version. */
  versionLine: FittedText;
  root: FittedText;
  /** The root plate's width: the root's text plus its margin, never past 128. */
  plateWidth: number;
  tooltip: string;
};
export type CacheNodeType = Node<CacheNodeData, 'cache'>;

const W = CACHE_W, H = CACHE_H, MID = CACHE_W / 2;

/**
 * A cache: a square in the step's border style (spec §5.1; mockup v50 drawCacheTag, gallery K5a).
 * Inside, stacked and centred: a hex mark, the name, CACHE and version, and the root on a plate.
 * Static: a cache is shared data, not a process, so nothing on it moves.
 */
export function CacheView({ lines, versionLine, root, plateWidth, tooltip }: CacheNodeData) {
  const one = lines.length === 1;
  return (
    <g className="cachetag nx">
      <title>{tooltip}</title>
      <path className="nx-bd" d={CACHE_FRAME} />
      <g className="nx-g"><path className="nx-hl nx-brk" d={CACHE_FRAME} /></g>
      <path className="nx-ln nx-d2 nx-thin" d={CACHE_FRAME_IN} />
      {[0, 1, 2, 3].map((i) => <path key={`t${i}`} className="nx-fc nx-g" d={`M${64 + i * 9} 0.5h6l-2 3h-6z`} />)}
      {[0, 1, 2, 3, 4].map((i) => <rect key={`b${i}`} className="nx-fc" x={66 + i * 7} y={155.5} width={3} height={3} />)}
      {[0, 1, 2, 3].map((i) => (
        <Fragment key={`s${i}`}>
          <path className="nx-fc nx-d1" d={`M2 ${66 + i * 7}l3-2v4l-3 2z`} />
          <rect className="nx-fc nx-d1" x={155} y={64 + i * 7} width={3} height={3} />
        </Fragment>
      ))}
      <g className="nx-g"><polygon className="nx-hl nx-bd nx-hex" points={hexPoints(MID, 46, 20)} /></g>
      <g className="nx-g"><polygon className="nx-fh" points={hexPoints(MID, 46, 10)} /></g>
      {lines.map((line, k) => <text key={k} className="nx-cn" x={MID} y={one ? 95 : 88 + k * 14} textAnchor="middle">{line}</text>)}
      <text className="nx-cl" x={MID} y={116} textAnchor="middle">{versionLine.text}</text>
      <rect className="nx-bd" x={MID - plateWidth / 2} y={126} width={plateWidth} height={18} rx={3} />
      <rect className="nx-hl nx-g nx-plate" x={MID - plateWidth / 2} y={126} width={plateWidth} height={18} rx={3} />
      <text className="nx-root" x={MID} y={138.5} textAnchor="middle">{root.text}</text>
    </g>
  );
}

export function CacheNode({ data }: NodeProps<CacheNodeType>) {
  return (
    <>
      <Handle id="in" type="target" position={Position.Top} isConnectable={false} />
      <svg width={W} height={H} overflow="visible" style={{ display: 'block' }}>
        <CacheView {...data} />
      </svg>
    </>
  );
}
