/** An edge of the layout. A tool pane remembers the one it sat nearest. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

/** dockview's placement words: beside a reference, or `within` it (as a tab of its group). */
export type Direction = 'left' | 'right' | 'above' | 'below' | 'within';

/** dockview's drop positions, for `moveTo`. */
export type Position = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface Rect { left: number; top: number; right: number; bottom: number }

/** One docked group's box, named by a panel in it. */
export interface GroupBox { ref: string; left: number; top: number; width: number; height: number }

/**
 * Where a group sat before it left the layout (spec §6.2.3): a panel of the neighbour it touched,
 * which side of that neighbour it was on, its width (left/right) or height (above/below), and the
 * box of every docked group at that moment, so the whole layout can be put back as it was.
 */
export interface Home { ref: string; direction: Direction; size: number; layout: GroupBox[] }

export const SIDE_DIRECTION: Readonly<Record<Side, Direction>> = { left: 'left', right: 'right', top: 'above', bottom: 'below' };

export function toPosition(direction: Direction): Position {
  switch (direction) {
    case 'above': return 'top';
    case 'below': return 'bottom';
    case 'within': return 'center';
    default: return direction;
  }
}

/**
 * The edge of the dock a group belongs to: a tall pane to the nearer of left and right, a wide one
 * to the nearer of top and bottom (a tie goes right, or bottom). Its rail is that edge's.
 */
export function sideOf(group: Rect, dock: Rect): Side {
  const tall = group.bottom - group.top > group.right - group.left;
  if (tall) return group.left - dock.left < dock.right - group.right ? 'left' : 'right';
  return group.top - dock.top < dock.bottom - group.bottom ? 'top' : 'bottom';
}

const TOUCH = 6; // px: closer than this, two groups share an edge
const SHARED = 20; // px: and they must overlap along it by more than this

/**
 * The neighbour the group shares the longest edge with, and on which side of it the group sits
 * (mockup v49 recordHome). Null when it touches no other group.
 */
export function findHome(group: Rect, neighbours: readonly { ref: string; rect: Rect }[]): Omit<Home, 'layout'> | null {
  const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.min(a2, b2) - Math.max(a1, b1);
  let best: (Omit<Home, 'layout'> & { shared: number }) | null = null;
  for (const { ref, rect: q } of neighbours) {
    const vertical = overlap(group.top, group.bottom, q.top, q.bottom);
    const horizontal = overlap(group.left, group.right, q.left, q.right);
    const candidates: [Direction, number, number][] = [
      ['right', Math.abs(group.left - q.right), vertical],
      ['left', Math.abs(group.right - q.left), vertical],
      ['below', Math.abs(group.top - q.bottom), horizontal],
      ['above', Math.abs(group.bottom - q.top), horizontal],
    ];
    for (const [direction, gap, shared] of candidates) {
      if (gap < TOUCH && shared > SHARED && (best === null || shared > best.shared)) {
        const size = direction === 'left' || direction === 'right' ? group.right - group.left : group.bottom - group.top;
        best = { ref, direction, size: Math.round(size), shared };
      }
    }
  }
  return best === null ? null : { ref: best.ref, direction: best.direction, size: best.size };
}
