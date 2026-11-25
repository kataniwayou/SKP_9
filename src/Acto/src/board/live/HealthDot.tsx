import { useId } from 'react';
import type { Health } from '../../api/liveness';
import { useHealthOf, useProcessorLive } from '../../live/LiveContext';
import { livenessText } from '../../live/liveState';

export const HEALTH_COLOUR: Record<Health, string> = { healthy: '#16A34A', unhealthy: '#DC2626', undetermined: '#94A3B8' };

/** One heart outline (24-unit box), shared by the whole and the broken heart. */
const HEART = 'M12 20.3C9.2 18.5 3.4 14.4 2.6 10 2 6.7 4.2 4 7.2 4c2 0 3.7 1.1 4.8 2.9C13.1 5.1 14.8 4 16.8 4c3 0 5.2 2.7 4.6 6-.8 4.4-6.6 8.5-9.4 10.3Z';
/** The crack through a broken heart: cut out of the outline by a mask, so the two halves stand apart. */
const CRACK = 'M12.6 5.4 10.6 10.4 13.6 12.6 11.4 18.2';

/**
 * A processor's health, as Grafana's alert list draws a rule's state [user, 2026-11-25]: an outline heart when it is live
 * (Grafana: OK), a broken heart when it is not (Grafana: Alerting), and a question mark in a circle when nobody can say
 * (Grafana: No data). Green, red and slate as before; the title says the detail.
 */
export function HealthDot({ processorId }: { processorId: string | null }) {
  const healthOf = useHealthOf();
  const { known, processor } = useProcessorLive(processorId ?? '');
  const health = !processorId ? 'undetermined' : healthOf(processorId);
  const text = livenessText(known, processor);
  const mask = `crack-${useId()}`;
  return (
    <span data-testid="health-dot" data-health={health} className="health-dot" title={text} aria-label={text} role="img"
      style={{ color: HEALTH_COLOUR[health] }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {health === 'healthy' && <path d={HEART} />}
        {health === 'unhealthy' && (
          <>
            <defs>
              <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
                <rect width="24" height="24" fill="white" />
                <path d={CRACK} stroke="black" strokeWidth={3.4} fill="none" />
              </mask>
            </defs>
            <path d={HEART} mask={`url(#${mask})`} />
            <path d={CRACK} strokeWidth={1.4} />
          </>
        )}
        {health === 'undetermined' && (
          <>
            <circle cx="12" cy="12" r="9.5" />
            <path d="M9.4 9.4a2.7 2.7 0 1 1 3.9 2.4c-.8.4-1.3 1-1.3 1.9v.5" />
            <circle cx="12" cy="17.2" r=".4" fill="currentColor" />
          </>
        )}
      </svg>
    </span>
  );
}
