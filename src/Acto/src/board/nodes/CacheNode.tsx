import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { ItemToolbar, useHasToolbar } from '../ItemToolbar';
import type { Pick } from '../selection';
import type { PickInfo } from '../toFlow';
import { PickBadge } from './PickBadge';
import { UnsavedMark } from './UnsavedMark';

/** A cache's colour: the block's line, and the icon of a cache in the toolbox and the Inspector. */
export const CACHE_TONE = 'var(--cache-line)';

/** A cache: a block on the board. Workflows join it with a dashed line from their back (handle `in`, on top). */
export function CacheNode({ data, selected }: NodeProps) {
  const { cacheId, name, ghost = false, ghostKey, failed = false, unsaved, pick } = data as { cacheId: string; name: string; ghost?: boolean; ghostKey?: string; failed?: boolean; unsaved?: boolean; pick?: PickInfo };
  const self: Pick = ghostKey ? { kind: 'ghost', key: ghostKey } : { kind: 'cache', id: cacheId };
  const toolbar = useHasToolbar(self);
  return (
    <div className={`cache-chip${selected ? ' sel' : ''}${failed ? ' failed' : ''}${ghost ? ' ghost' : ''}`} title={name}>
      <PickBadge pick={pick} />
      <UnsavedMark on={unsaved} />
      {selected && pick?.solo && toolbar && (
        <NodeToolbar isVisible position={Position.Top} offset={10}><ItemToolbar pick={self} /></NodeToolbar>
      )}
      <Handle id="in" type="target" position={Position.Top} />
      <span className="cache-ico" aria-hidden="true">⛁</span>
      <span className="cache-nm">{name}</span>
      {ghost && <span className="ghost-tag">deleted · ghost</span>}
    </div>
  );
}
