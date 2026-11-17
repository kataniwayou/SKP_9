import type { Id } from '../model/graph';

export type StepRole = 'first' | 'parked' | 'reached';

export function stepRoles(stepIds: Id[], links: ReadonlyArray<{ from: Id; to: Id }>): Map<Id, StepRole> {
  const incoming = new Set<Id>();
  const outgoing = new Set<Id>();
  for (const l of links) {
    outgoing.add(l.from);
    incoming.add(l.to);
  }
  const roles = new Map<Id, StepRole>();
  for (const id of stepIds) {
    const hasIn = incoming.has(id);
    const hasOut = outgoing.has(id);
    if (!hasIn && hasOut) roles.set(id, 'first');
    else if (!hasIn && !hasOut) roles.set(id, stepIds.length === 1 ? 'first' : 'parked');
    else roles.set(id, 'reached');
  }
  return roles;
}

export function derivedEntrySteps(roles: ReadonlyMap<Id, StepRole>): Id[] {
  return [...roles].filter(([, r]) => r === 'first').map(([id]) => id);
}

export function entryDiff(stored: Id[], derived: Id[]): { stops: Id[]; starts: Id[] } {
  return {
    stops: stored.filter((id) => !derived.includes(id)),
    starts: derived.filter((id) => !stored.includes(id)),
  };
}
