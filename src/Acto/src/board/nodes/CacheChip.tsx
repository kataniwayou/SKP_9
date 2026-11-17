import { NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { useBoardWorkflow, useToolbarActions } from './boardContext';
import { Toolbar } from '../Toolbar';

export function CacheChip({ data, selected }: NodeProps) {
  const { workflowId, cacheId } = data as { workflowId: string; cacheId: string };
  const info = useBoardWorkflow(workflowId);
  const tb = useToolbarActions();
  const cache = info?.graph.caches.get(cacheId);
  if (!cache) return null;
  return (
    <div className={`cache-chip${selected ? ' sel' : ''}`} title={cache.name}>
      {selected && tb && (
        <NodeToolbar isVisible position={Position.Top} offset={10}>
          <Toolbar selection={{ kind: 'cache' }} actions={{ onDelete: () => tb.deleteCache(workflowId, cacheId) }} />
        </NodeToolbar>
      )}
      <span className="cache-ico" aria-hidden="true">C</span>
      <span className="cache-nm">{cache.name}</span>
    </div>
  );
}
