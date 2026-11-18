import type { Pick } from '../../board/selection';
import type { BoardState } from '../../design/board';
import { conditionInfo } from '../../model/entryConditions';
import { Ro, Row } from '../fields';
import { EntityHead, stepName } from './shared';

/** A wire, an entry arrow or a cache line: the entity head, then from, to and, for a step target, when it runs (read-only). */
export function LinkTab({ state, pick }: { state: BoardState; pick: Extract<Pick, { kind: 'wire' | 'entry' | 'cacheLink' }> }) {
  if (pick.kind === 'cacheLink') {
    const from = state.workflows[pick.workflowId]?.name ?? pick.workflowId;
    const to = state.caches[pick.cacheId]?.name ?? pick.cacheId;
    return (
      <>
        <EntityHead name={`${from} → ${to}`} kind="cache line" />
        <Ro><Row k="From">{from}</Row><Row k="To">{to}</Row></Ro>
        <p className="none">{`${from} uses the cache ${to}.`}</p>
      </>
    );
  }
  const toId = pick.kind === 'wire' ? pick.to : pick.stepId;
  const from = pick.kind === 'wire' ? stepName(state, pick.from) : state.workflows[pick.workflowId]?.name ?? pick.workflowId;
  const to = stepName(state, toId);
  return (
    <>
      <EntityHead name={`${from} → ${to}`} kind={pick.kind === 'wire' ? 'wire' : 'entry arrow'} />
      <Ro>
        <Row k="From">{from}</Row>
        <Row k="To">{to}</Row>
        <Row k="Runs when">{conditionInfo(state.steps[toId]?.entryCondition ?? 0).name}</Row>
      </Ro>
      <p className="none">{`The colour is the entry condition of ${to}. Change it on that step; every wire into it follows.`}</p>
    </>
  );
}
