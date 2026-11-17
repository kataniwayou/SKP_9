import type { LiveStatus } from '../../api/liveStatus';

export const STATE_COLOUR: Record<LiveStatus, string> = {
  running: '#16A34A', stopped: '#DC2626', checking: '#D97706', unknown: '#D97706',
};

/** The mock's .state pill: Running (green, pulsing dot), Stopped (red), Checking… (amber) while not known. */
export function StateBadge({ status }: { status: LiveStatus }) {
  const label = status === 'running' ? 'Running' : status === 'stopped' ? 'Stopped' : 'Checking…';
  const tone = status === 'running' ? 'on' : status === 'stopped' ? 'off' : 'checking';
  return <span className={`state-badge state ${tone}`} data-status={status}>{label}</span>;
}
