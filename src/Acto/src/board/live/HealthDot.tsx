import type { Health } from '../../api/liveness';
import { useHealthOf, useProcessorLive } from '../../live/LiveContext';
import { livenessText } from '../../live/liveState';

export const HEALTH_COLOUR: Record<Health, string> = { healthy: '#16A34A', unhealthy: '#DC2626', undetermined: '#94A3B8' };

export function HealthDot({ processorId }: { processorId: string | null }) {
  const healthOf = useHealthOf();
  const { known, processor } = useProcessorLive(processorId ?? '');
  const health = processorId === null ? 'undetermined' : healthOf(processorId);
  return (
    <span data-testid="health-dot" data-health={health} className="health-dot" title={livenessText(known, processor)}
      style={{ background: HEALTH_COLOUR[health] }} />
  );
}
