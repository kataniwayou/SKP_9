import { useId, type ReactElement } from 'react';
import type { Health } from '../../api/liveness';
import { useHealthOf, useProcessorLive } from '../../live/LiveContext';
import { livenessText } from '../../live/liveState';

export const HEALTH_COLOUR: Record<Health, string> = { healthy: '#16A34A', unhealthy: '#DC2626', undetermined: '#94A3B8' };

/** One solid heart (24-unit box): every state is drawn from it. */
const HEART = 'M12 21.2C9 19.3 2.6 15 1.7 10.1 1 6.4 3.5 3.3 6.9 3.3c2.2 0 4 1.2 5.1 3.1 1.1-1.9 2.9-3.1 5.1-3.1 3.4 0 5.9 3.1 5.2 6.8C21.4 15 15 19.3 12 21.2Z';
/** Cut out of the fill, so the card shows through: the crack of a broken heart, the question mark of an unknown one. */
const CUTS: Partial<Record<Health, ReactElement>> = {
  unhealthy: <path d="M12.9 4.6 10.3 10.6 13.9 13.1 11.2 20.4" fill="none" stroke="black" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />,
  undetermined: (
    <>
      <path d="M10 9.4a2.2 2.2 0 1 1 3.1 2c-.6.3-1.1.8-1.1 1.5v.3" fill="none" stroke="black" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="15.9" r="1.1" fill="black" />
    </>
  ),
};

/**
 * A processor's health as a solid heart, the way Grafana's alert list draws a rule's state [user, 2026-11-25]: green and
 * beating when it is live (Grafana: OK), red and broken when it is not (Grafana: Alerting), slate with a question mark when
 * nobody can say (Grafana: No data). The crack and the question mark are cut out of the fill. The title says the detail.
 */
export function HealthDot({ processorId }: { processorId: string | null }) {
  const healthOf = useHealthOf();
  const { known, processor } = useProcessorLive(processorId ?? '');
  const health = !processorId ? 'undetermined' : healthOf(processorId);
  const text = livenessText(known, processor);
  const mask = `health-cut-${useId()}`;
  const cut = CUTS[health];
  return (
    <span data-testid="health-dot" data-health={health} className="health-dot" title={text} aria-label={text} role="img"
      style={{ color: HEALTH_COLOUR[health] }}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {cut && (
          <defs>
            <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
              <rect width="24" height="24" fill="white" />
              {cut}
            </mask>
          </defs>
        )}
        <path d={HEART} fill="currentColor" mask={cut ? `url(#${mask})` : undefined} />
      </svg>
    </span>
  );
}
