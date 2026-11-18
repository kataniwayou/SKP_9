import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { ItemToolbar, useHasToolbar } from '../ItemToolbar';
import type { PickInfo } from '../toFlow';
import { PickBadge } from './PickBadge';

/** A cache's colour: the block's line, and the icon of a cache in the toolbox and the Inspector. */
export const CACHE_TONE = 'var(--cache-line)';

/** A cache: a block on the board. Workflows join it with a dashed line from their back (handle `in`, on top). */
export function CacheNode({ data, selected }: NodeProps) {
  const { cacheId, name, failed = false, pick } = data as { cacheId: string; name: string; failed?: boolean; pick?: PickInfo };
  const self = { kind: 'cache', id: cacheId } as const;
  const toolbar = useHasToolbar(self);
  return (
    <div className={`cache-chip${selected ? ' sel' : ''}${failed ? ' failed' : ''}`} title={name}>
      <PickBadge pick={pick} />
      {selected && pick?.solo && toolbar && (
        <NodeToolbar isVisible position={Position.Top} offset={10}><ItemToolbar pick={self} /></NodeToolbar>
      )}
      <Handle id="in" type="target" position={Position.Top} />
      <span className="cache-ico" aria-hidden="true">C</span>
      <span className="cache-nm">{name}</span>
    </div>
  );
}
