import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CACHE_H, CACHE_W } from '../../layout/geometry';
import type { FittedText } from '../fitText';
import { Label } from './Label';

export type CacheNodeData = { name: FittedText; sub: FittedText };
export type CacheNodeType = Node<CacheNodeData, 'cache'>;

const W = CACHE_W, H = CACHE_H;

/** A cache: the glass cap over a dark body, with a stack of lit discs (mockup drawCacheTag). */
export function CacheView({ name, sub }: CacheNodeData) {
  return (
    <g className="cachetag">
      <rect className="contact" x={5} y={8} width={W} height={H} rx={9} />
      <rect className="shell" width={W} height={H} rx={8} />
      <path className="cap" d={`M0 8 a8 8 0 0 1 8 -8 H${W - 8} a8 8 0 0 1 8 8 V28 H0Z`} />
      <ellipse cx={54} cy={7} rx={54} ry={7} fill="url(#glint)" opacity={0.55} />
      <path d={`M0 28 H${W}`} stroke="rgba(160,215,255,.5)" />
      <rect className="rimr" x={0.6} y={0.6} width={W - 1.2} height={H - 1.2} rx={7.5} />
      {[44, 36, 28].map((y) => <ellipse key={y} cx={W - 24} cy={y} rx={14} ry={5} fill="url(#drum)" stroke="rgba(200,235,255,.45)" strokeWidth={0.6} />)}
      <ellipse cx={W - 24} cy={20} rx={14} ry={5} fill="url(#drumTop)" stroke="rgba(220,240,255,.5)" strokeWidth={0.6} />
      <Label className="cname" x={12} y={19} fitted={name} />
      <Label className="csub" x={12} y={46} fitted={sub} />
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
