import type { Health } from '../../api/liveness';
import { useHealthOf, useProcessorLive } from '../../live/LiveContext';
import { livenessText } from '../../live/liveState';

export const HEALTH_COLOUR: Record<Health, string> = { healthy: '#16A34A', unhealthy: '#DC2626', undetermined: '#94A3B8' };

export function HealthDot({ processorId }: { processorId: string | null }) {
  const healthOf = useHealthOf();
  const { known, processor } = useProcessorLive(processorId ?? '');
  const health = !processorId ? 'undetermined' : healthOf(processorId);
  const text = livenessText(known, processor);
  return (
    <span data-testid="health-dot" data-health={health} className="health-dot" title={text} aria-label={text}
      style={{ background: HEALTH_COLOUR[health] }} />
  );
}
