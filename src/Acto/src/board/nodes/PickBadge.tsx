import { useStore } from '@xyflow/react';

export interface PickInfo { no: number; solo: boolean }

/** The pink pick-order badge; a single pick shows none. Kept one size at any zoom. */
export function PickBadge({ pick, className = '' }: { pick: PickInfo | undefined; className?: string }) {
  const zoom = useStore((s) => s.transform[2]);
  if (!pick || pick.solo) return null;
  return <span className={`pick-no ${className}`} style={{ transform: `scale(${1 / zoom})` }}>{pick.no}</span>;
}
