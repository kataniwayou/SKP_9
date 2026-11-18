import { CACHE_TONE } from '../../board/nodes/CacheNode';
import type { Pick } from '../../board/selection';
import { conditionStyle } from '../../board/wires';
import type { BoardState } from '../../design/board';
import { conditionInfo } from '../../model/entryConditions';
import { Ro, Row } from '../fields';
import { stepName } from './shared';

/** The mock's .ins-title: an icon, the bold name and a small line under it. */
const Title = ({ tone, letter, name, sub }: { tone: string; letter: string; name: string; sub: string }) => (
  <div className="ins-title"><span className="ico" style={{ background: tone }}>{letter}</span><div><b>{name}</b><small>{sub}</small></div></div>
);

/** A wire, an entry arrow or a cache line: from, to and, for a step target, when it runs. */
export function LinkTab({ state, pick }: { state: BoardState; pick: Extract<Pick, { kind: 'wire' | 'entry' | 'cacheLink' }> }) {
  if (pick.kind === 'cacheLink') {
    const from = state.workflows[pick.workflowId]?.name ?? pick.workflowId;
    const to = state.caches[pick.cacheId]?.name ?? pick.cacheId;
    return (
      <>
        <Title tone={CACHE_TONE} letter="C" name={`${from} → ${to}`} sub="cache line" />
        <Ro><Row k="From">{from}</Row><Row k="To">{to}</Row></Ro>
        <p className="none">{`${from} uses the cache ${to}.`}</p>
      </>
    );
  }
  const toId = pick.kind === 'wire' ? pick.to : pick.stepId;
  const from = pick.kind === 'wire' ? stepName(state, pick.from) : state.workflows[pick.workflowId]?.name ?? pick.workflowId;
  const to = stepName(state, toId);
  const c = conditionStyle(state.steps[toId]?.entryCondition ?? 0);
  return (
    <>
      <Title tone={c.colour} letter={c.letter} name={`${from} → ${to}`} sub={pick.kind === 'wire' ? 'wire' : 'entry arrow'} />
      <Ro>
        <Row k="From">{from}</Row>
        <Row k="To">{to}</Row>
        <Row k="Runs when">{conditionInfo(state.steps[toId]?.entryCondition ?? 0).name}</Row>
      </Ro>
      <p className="none">{`The colour is the entry condition of ${to}. Change it on that step; every wire into it follows.`}</p>
    </>
  );
}
