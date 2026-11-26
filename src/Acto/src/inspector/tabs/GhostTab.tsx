import type { SchemaRow } from '../../design/board';
import type { BoardState } from '../../design/board';
import type { GhostItem, GhostStore } from '../../design/ghosts';
import { conditionInfo } from '../../model/entryConditions';
import type { Id } from '../../model/graph';
import { Ro, Row } from '../fields';
import { JsonView } from '../JsonField';
import { MetaToggle } from '../MetaToggle';
import { EntityHead, metaOfRow } from './shared';

type Lookup = Pick<GhostStore, 'get'>;

/** A name for an end of a ghost link: the item on the board, else its own ghost, else the id. */
function nameOf(b: BoardState, ghosts: Lookup, kind: 'step' | 'cache' | 'workflow', id: Id): string {
  const live = kind === 'step' ? b.steps[id] : kind === 'cache' ? b.caches[id] : b.workflows[id];
  if (live) return live.name;
  const g = ghosts.get(`${kind}:${id}`);
  return g && 'row' in g ? g.row.name : id;
}

type LinkGhost = Extract<GhostItem, { kind: 'wire' | 'entry' | 'cacheLink' }>;
/** A ghost link's two ends by name. */
function endsOf(g: LinkGhost, b: BoardState, ghosts: Lookup): [string, string] {
  switch (g.kind) {
    case 'wire': return [nameOf(b, ghosts, 'step', g.from), nameOf(b, ghosts, 'step', g.to)];
    case 'entry': return [nameOf(b, ghosts, 'workflow', g.workflowId), nameOf(b, ghosts, 'step', g.stepId)];
    case 'cacheLink': return [nameOf(b, ghosts, 'workflow', g.workflowId), nameOf(b, ghosts, 'cache', g.cacheId)];
  }
}

/** A ghost's name for the pick list and the head. */
export function ghostName(g: GhostItem, b: BoardState, ghosts: Lookup): string {
  return 'row' in g ? g.row.name : endsOf(g, b, ghosts).join(' → ');
}

const KIND: Readonly<Record<GhostItem['kind'], string>> = {
  step: 'step', cache: 'cache', workflow: 'workflow', schema: 'schema', wire: 'wire', entry: 'entry arrow', cacheLink: 'cache line',
};

/** A deleted item as it was last seen: read-only. */
export function GhostTab({ state, ghosts, item }: { state: BoardState; ghosts: Lookup; item: GhostItem }) {
  const name = ghostName(item, state, ghosts);
  const head = <EntityHead name={'row' in item ? `${item.row.name} ${item.row.version}` : name} kind={`deleted · ${KIND[item.kind]}`} />;
  const note = <p className="in-note">Deleted — Restore or Remove from its toolbar.</p>;
  if (item.kind === 'wire' || item.kind === 'entry' || item.kind === 'cacheLink') {
    const [from, to] = endsOf(item, state, ghosts);
    return (
      <>
        {head}
        <Ro>
          <Row k="From">{from}</Row>
          <Row k="To">{to}</Row>
          {item.kind === 'wire' && <Row k="Runs when">{conditionInfo(item.condition).name}</Row>}
        </Ro>
        {note}
      </>
    );
  }
  const r = item.row;
  return (
    <>
      {head}
      <Ro>
        <Row k="Name">{r.name}</Row>
        <Row k="Version">{r.version}</Row>
      </Ro>
      <MetaToggle meta={item.kind === 'schema' ? { id: r.id, ...item.row.audit } : metaOfRow(r as Exclude<typeof r, SchemaRow>)} />
      <Ro>
        <Row k="Description">{r.description ?? '—'}</Row>
        {item.kind === 'step' && <Row k="Processor">{item.row.processorId === null ? 'none' : state.processors[item.row.processorId]?.name ?? item.row.processorId}</Row>}
        {item.kind === 'step' && <Row k="Entry condition">{conditionInfo(item.row.entryCondition).name}</Row>}
        {item.kind === 'workflow' && <Row k="Assignments">{String(item.assignments.length)}</Row>}
        {item.kind === 'cache' && <Row k="Root">{item.row.root}</Row>}
      </Ro>
      {item.kind === 'cache' && <JsonView label="Items" value={item.row.items} />}
      {note}
    </>
  );
}
