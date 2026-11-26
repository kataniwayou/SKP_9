import type { Pick } from '../../board/selection';
import type { BoardState } from '../../design/board';
import { schemaRefs, schemaStates, steplessProcessors } from '../../design/schemaStates';
import type { Id } from '../../model/graph';
import type { ToolContext, ToolOutcome } from '../toolTypes';
import { fail } from './common';

// The Schemas mode's cards as the chat sees them, by the board's own rules [user, 2026-11-26]: every schema is a card
// (wired: a processor some step runs fills one of its slots; held: only a processor no step uses does; orphan: none), a
// processor no step uses that holds a schema is a read-only card, and only while the mode is on are they drawn.

export const MODE_OFF = 'the Schemas mode is off, so schema and processor cards are not on the board: set_schemas_mode turns it on';

/** A schema or processor card the board draws now; the failed outcome otherwise. */
export function onCard(ctx: ToolContext, kind: 'schema' | 'processor', id: string, action: string): { id: Id } | { out: ToolOutcome } {
  if (!ctx.commands.schemasMode()) return { out: fail(MODE_OFF, action) };
  const b = ctx.store.state();
  const none = `no ${kind} ${id === '' ? '(none given)' : id} on the board`;
  if (kind === 'schema') return b.schemas[id] ? { id } : { out: fail(none, action) };
  const p = b.processors[id];
  if (!p) return { out: fail(none, action) };
  if (!steplessProcessors(b).includes(id)) {
    return { out: fail(`processor ${p.name} ${p.version} has no card: only a processor no step uses that holds a schema is drawn (a processor steps run shows on those steps)`, action) };
  }
  return { id };
}

const stepNames = (b: BoardState, schemaId: Id) =>
  [...new Set(schemaRefs(b).filter((r) => r.schemaId === schemaId && r.owner.kind === 'step').map((r) => b.steps[r.owner.id]?.name ?? r.owner.id))];
const holderNames = (b: BoardState, schemaId: Id) =>
  [...new Set(schemaRefs(b).filter((r) => r.schemaId === schemaId && r.owner.kind === 'processor').map((r) => {
    const p = b.processors[r.owner.id];
    return p ? `${p.name} ${p.version}` : r.owner.id;
  }))];

/** What read_board says of the cards: every schema with its state, users and place, and the processor cards. */
export function cardsOf(ctx: ToolContext) {
  const b = ctx.store.state();
  const states = schemaStates(b);
  const refs = schemaRefs(b);
  const schemas = Object.values(b.schemas).map((s) => ({
    id: s.id, name: s.name, version: s.version, description: s.description, state: states[s.id],
    usedBy: refs.filter((r) => r.schemaId === s.id && r.owner.kind === 'step').map((r) => ({ stepId: r.owner.id, slot: r.slot })),
    heldBy: refs.filter((r) => r.schemaId === s.id && r.owner.kind === 'processor').map((r) => ({ processorId: r.owner.id, slot: r.slot })),
    at: s.at,
  }));
  const processorCards = steplessProcessors(b).map((id) => {
    const p = b.processors[id]!;
    return { id, name: p.name, version: p.version, holds: refs.filter((r) => r.owner.kind === 'processor' && r.owner.id === id).map((r) => ({ schemaId: r.schemaId, slot: r.slot })), at: p.at };
  });
  return { schemasMode: ctx.commands.schemasMode() ? 'on' : 'off', schemas, processorCards };
}

/**
 * Why a Delete of these picks must not happen because of the cards in them, by the toolbar's rule: orphan schemas alone
 * Delete; a wired or held schema, any processor, or a mix of orphans with other items has no Delete. Empty: no card objects.
 */
export function cardDeleteRefusal(picks: readonly Pick[], b: BoardState): string[] {
  const cards = picks.filter((p) => p.kind === 'schema' || p.kind === 'processor');
  if (cards.length === 0) return [];
  const states = schemaStates(b);
  const lines = cards.flatMap((p): string[] => {
    if (p.kind === 'processor') {
      const pr = b.processors[p.id];
      return [`processor ${pr ? `${pr.name} ${pr.version}` : p.id} is never deleted: Acto does not change, copy or delete a processor`];
    }
    if (p.kind !== 'schema') return [];
    const s = b.schemas[p.id];
    const name = s ? `${s.name} ${s.version}` : p.id;
    if (states[p.id] === 'wired') return [`schema ${name} is wired (used by step ${stepNames(b, p.id).join(', ')}): only an orphan schema can be deleted`];
    if (states[p.id] === 'held') return [`schema ${name} is held by processor ${holderNames(b, p.id).join(', ')}, which no step uses: only an orphan schema can be deleted`];
    return [];
  });
  if (lines.length > 0) return lines;
  return cards.length === picks.length ? [] : ['orphan schemas are deleted on their own: pick them without other items'];
}
