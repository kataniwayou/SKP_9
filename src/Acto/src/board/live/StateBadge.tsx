import type { LiveStatus } from '../../api/liveStatus';

/** A run state's colour (tokens.css --st-*): the minimap's frame outline; a frame's stripe takes the same from its class. */
export const STATE_COLOUR: Record<LiveStatus, string> = {
  running: 'var(--st-on)', stopped: 'var(--st-off)', checking: 'var(--st-wait)', unknown: 'var(--st-wait)',
};

/** The mock's .state pill: Running (green, pulsing dot), Stopped (red), Checking… (amber) while not known. */
export function StateBadge({ status }: { status: LiveStatus }) {
  const label = status === 'running' ? 'Running' : status === 'stopped' ? 'Stopped' : 'Checking…';
  const tone = status === 'running' ? 'on' : status === 'stopped' ? 'off' : 'checking';
  return <span className={`state-badge state ${tone}`} data-status={status}>{label}</span>;
}
