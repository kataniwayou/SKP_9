import type { LiveStatus } from '../../api/liveStatus';

export const STATE_COLOUR: Record<LiveStatus, string> = {
  running: '#16A34A', stopped: '#DC2626', checking: '#D97706', unknown: '#D97706',
};

export function StateBadge({ status }: { status: LiveStatus }) {
  const colour = STATE_COLOUR[status];
  const label = status === 'running' ? 'Running' : status === 'stopped' ? 'Stopped' : 'Checking…';
  return (
    <span className={`state-badge ${status}`} data-status={status} style={{ color: colour, borderColor: colour }}>
      <span className={`sb-dot${status === 'running' ? ' pulse' : ''}`} style={{ background: colour }} />
      {label}
    </span>
  );
}
