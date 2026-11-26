import { describe, expect, it } from 'vitest';
import { board, scheduledBoard, schemaBoard } from '../design/boardFixtures';
import type { Pick } from './selection';
import type { GhostItem } from '../design/ghosts';
import { flowIdOf, toFlow, type BoardView } from './toFlow';

const view = (over: Partial<BoardView> = {}): BoardView => ({ workflows: [], picks: [], live: () => 'stopped', ...over });
const twoKeys = () => {
  const c = board();
  return { ...c, assignments: { ...c.assignments,
    'a-daily-fetch': { ...c.assignments['a-daily-fetch']!, payload: '{"a":1,"b":2}' },
    'a-hourly-fetch': { ...c.assignments['a-hourly-fetch']!, payload: '[1]' } } };
};
const dim = (x: { className?: string | undefined }) => (x.className ?? '').split(' ').includes('dim');

describe('toFlow', () => {
  const b = board();
  // both entry arrows scheduled: only a scheduled arrow fires, so motion needs a cron [user, 2026-11-25]
  const sched = scheduledBoard();
  const hourlyRuns = (id: string) => (id === 'hourly' ? 'running' : 'stopped') as 'running' | 'stopped';
  it('makes one node per workflow, step and cache, with the handles React Flow wires', () => {
    const { nodes } = toFlow(b, view());
    expect(nodes.map((n) => n.id).sort()).toEqual(['ca:c1', 'st:expand', 'st:fetch', 'st:lonely', 'wf:daily', 'wf:hourly']);
    const handles = (id: string) => nodes.find((n) => n.id === id)!.handles!.map((h) => `${h.type}:${h.id}:${h.position}`);
    expect(handles('wf:daily')).toEqual(['source:tip:right', 'source:back:left']);
    expect(handles('st:fetch')).toEqual(['target:in:left', 'source:out:right']);
    expect(handles('ca:c1')).toEqual(['target:in:top']);
    expect(nodes.find((n) => n.id === 'st:fetch')!.position).toEqual({ x: 200, y: 200 });
  });
  it('carries the marks: problems on a triangle, a failure on what a refused Save named', () => {
    const { nodes } = toFlow(b, view({ problems: (wf) => (wf === 'daily' ? 2 : 0), failed: (k) => k === 'workflow:hourly' || k === 'step:fetch' || k === 'cache:c1' }));
    const data = (id: string) => nodes.find((n) => n.id === id)!.data as { problems?: number; failed?: boolean };
    expect(data('wf:daily')).toMatchObject({ problems: 2, failed: false });
    expect(data('wf:hourly')).toMatchObject({ problems: 0, failed: true });
    expect(data('st:fetch').failed).toBe(true);
    expect(data('st:expand').failed).toBe(false);
    expect(data('ca:c1').failed).toBe(true);
  });
  it('makes one edge per wire, entry arrow and cache link', () => {
    const { edges } = toFlow(b, view());
    expect(edges.map((e) => [e.id, e.type, e.source, e.sourceHandle, e.target, e.targetHandle])).toEqual([
      ['wire:fetch:expand', 'wire', 'st:fetch', 'out', 'st:expand', 'in'],
      ['entry:daily:fetch', 'entry', 'wf:daily', 'tip', 'st:fetch', 'in'],
      ['entry:hourly:fetch', 'entry', 'wf:hourly', 'tip', 'st:fetch', 'in'],
      ['cache:daily:c1', 'cacheLink', 'wf:daily', 'back', 'ca:c1', 'in'],
    ]);
  });
  it('takes the wire colour from the target step and runs it while a workflow reaching it runs', () => {
    const w = (v: BoardView) => toFlow(sched, v).edges.find((e) => e.id === 'wire:fetch:expand')!.data as { condition: number; running: boolean };
    expect(w(view())).toMatchObject({ condition: 1, running: false });
    expect(w(view({ live: (id) => (id === 'hourly' ? 'running' : 'stopped') })).running).toBe(true);
  });
  it('nothing is dimmed when a workflow is selected', () => {
    const { nodes, edges } = toFlow(b, view({ workflows: ['daily'] }));
    expect([...nodes, ...edges].some(dim)).toBe(false);
  });
  it('chips: one per selected workflow with an assignment on the step', () => {
    const c = twoKeys();
    const chips = (v: BoardView) => (toFlow(c, v).nodes.find((n) => n.id === 'st:fetch')!.data as { chips: unknown }).chips;
    expect(chips(view())).toEqual([]);
    expect(chips(view({ workflows: ['daily'] }))).toEqual([{ text: '◆ 2 keys', hue: '#FF0072' }]);
    expect(chips(view({ workflows: ['daily', 'hourly'] }))).toEqual([{ text: '◆ 2 keys · daily', hue: '#FF0072' }, { text: '◆ payload · hourly', hue: '#7C3AED' }]);
    // the full workflow name, dashes and all (R10)
    const dashed = { ...c, workflows: { ...c.workflows, daily: { ...c.workflows.daily!, name: 'daily-orders-run' } } };
    expect((toFlow(dashed, view({ workflows: ['daily', 'hourly'] })).nodes.find((n) => n.id === 'st:fetch')!.data as { chips: { text: string }[] }).chips[0]!.text)
      .toBe('◆ 2 keys · daily-orders-run');
    const none = toFlow(c, view({ workflows: ['daily'] })).nodes.find((n) => n.id === 'st:expand')!.data as { chips: unknown };
    expect(none.chips).toEqual([]);
  });
  it('a step is running when a running workflow reaches it', () => {
    const live = (id: string) => (id === 'hourly' ? 'running' : 'stopped') as 'running' | 'stopped';
    const n = toFlow(sched, view({ live })).nodes;
    const run = (id: string) => (n.find((x) => x.id === id)!.data as { running: boolean }).running;
    expect([run('st:fetch'), run('st:expand'), run('st:lonely')]).toEqual([true, true, false]);
  });
  it('a wire runs only when a running workflow reaches its source', () => {
    const w = (live: (id: string) => 'running' | 'stopped') => (toFlow(sched, view({ live })).edges.find((e) => e.id === 'wire:fetch:expand')!.data as { running: boolean }).running;
    expect(w((id) => (id === 'hourly' ? 'running' : 'stopped'))).toBe(true);
    expect(w(() => 'stopped')).toBe(false);
  });
  it('a wire into a Never step never moves: it never fires, even while a running workflow reaches its source [user, 2026-11-23 item 4]', () => {
    const never = { ...sched, steps: { ...sched.steps, expand: { ...sched.steps.expand!, entryCondition: 5 } } };
    const d = toFlow(never, view({ live: (id) => (id === 'hourly' ? 'running' : 'stopped') })).edges.find((e) => e.id === 'wire:fetch:expand')!.data as { condition: number; running: boolean };
    expect(d).toMatchObject({ condition: 5, running: false });
  });
  it('an entry arrow runs only while its workflow runs; cache lines never run', () => {
    const { edges } = toFlow(sched, view({ live: (id) => (id === 'hourly' ? 'running' : 'stopped') }));
    const d = (id: string) => edges.find((e) => e.id === id)!.data as { running?: boolean };
    expect(d('entry:hourly:fetch').running).toBe(true);
    expect(d('entry:daily:fetch').running).toBe(false);
    expect(d('cache:daily:c1').running).toBeUndefined();
  });
  it('an unscheduled entry arrow (no cron) never fires: still and idle, and nothing it alone reaches runs [user, 2026-11-25]', () => {
    const { nodes, edges } = toFlow(b, view({ live: hourlyRuns }));
    const e = edges.find((x) => x.id === 'entry:hourly:fetch')!.data as { running: boolean; idle: string | null };
    expect(e).toMatchObject({ running: false, idle: 'unscheduled' });
    const run = (id: string) => (nodes.find((x) => x.id === id)!.data as { running: boolean }).running;
    expect([run('st:fetch'), run('st:expand')]).toEqual([false, false]);
    expect((edges.find((x) => x.id === 'wire:fetch:expand')!.data as { running: boolean }).running).toBe(false);
    // a blank cron is no cron
    const blank = { ...b, workflows: { ...b.workflows, hourly: { ...b.workflows.hourly!, entryCrons: { fetch: '   ' } } } };
    expect((toFlow(blank, view({ live: hourlyRuns })).edges.find((x) => x.id === 'entry:hourly:fetch')!.data as { idle: string | null }).idle).toBe('unscheduled');
  });
  it('a Never entry step is frozen: its arrow is still and idle even with a cron, it gets no ring, and nothing past it moves [user, 2026-11-25]', () => {
    const frozen = { ...sched, steps: { ...sched.steps, fetch: { ...sched.steps.fetch!, entryCondition: 5 } } };
    const { nodes, edges } = toFlow(frozen, view({ live: hourlyRuns }));
    expect(edges.find((x) => x.id === 'entry:hourly:fetch')!.data).toMatchObject({ running: false, idle: 'frozen', cron: '0 * * * * *' });
    const run = (id: string) => (nodes.find((x) => x.id === id)!.data as { running: boolean }).running;
    expect([run('st:fetch'), run('st:expand')]).toEqual([false, false]);
    expect((edges.find((x) => x.id === 'wire:fetch:expand')!.data as { running: boolean }).running).toBe(false);
    // frozen wins over a missing cron: the step is the operator's deliberate act
    const both = { ...b, steps: frozen.steps };
    expect((toFlow(both, view()).edges.find((x) => x.id === 'entry:hourly:fetch')!.data as { idle: string | null }).idle).toBe('frozen');
  });
  it('a Never step reached by a wire gets no ring, and neither does a step only it leads to', () => {
    const chain = { ...sched, steps: { ...sched.steps, expand: { ...sched.steps.expand!, entryCondition: 5, nextStepIds: ['lonely'] } } };
    const n = toFlow(chain, view({ live: hourlyRuns })).nodes;
    const run = (id: string) => (n.find((x) => x.id === id)!.data as { running: boolean }).running;
    expect([run('st:fetch'), run('st:expand'), run('st:lonely')]).toEqual([true, false, false]);
  });
  it('a scheduled entry arrow into a live step is not idle', () => {
    const d = toFlow(sched, view()).edges.find((x) => x.id === 'entry:daily:fetch')!.data as { idle: string | null };
    expect(d.idle).toBeNull();
  });
  it('anEntryEdgeWithItsOwnCronCarriesIt', () => {
    const withCron = { ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, entryCrons: { fetch: '*/10 * * * * *' } } } };
    const { edges } = toFlow(withCron, view());
    const d = (id: string) => edges.find((e) => e.id === id)!.data as { cron?: string };
    expect(d('entry:daily:fetch').cron).toBe('*/10 * * * * *');
    expect('cron' in d('entry:hourly:fetch')).toBe(false);
  });
  it('selected triangles carry their hue; entry arrows and cache lines of a selected workflow carry it', () => {
    const { nodes, edges } = toFlow(b, view({ workflows: ['hourly', 'daily'] }));
    const hue = (x: { id: string; data?: unknown }) => (x.data as { hue: string | null }).hue;
    expect(hue(nodes.find((n) => n.id === 'wf:hourly')!)).toBe('#FF0072');
    expect(hue(nodes.find((n) => n.id === 'wf:daily')!)).toBe('#7C3AED');
    expect(hue(edges.find((e) => e.id === 'entry:daily:fetch')!)).toBe('#7C3AED');
    expect(hue(edges.find((e) => e.id === 'cache:daily:c1')!)).toBe('#7C3AED');
    expect(hue(toFlow(b, view()).nodes.find((n) => n.id === 'wf:daily')!)).toBeNull();
  });
  describe('ghosts', () => {
    const lonely = b.steps.lonely!;
    const gstep: GhostItem = { key: 'step:gone', kind: 'step', row: { ...lonely, id: 'gone', name: 'gone', at: { x: 5, y: 6 } } };
    const wire: GhostItem = { key: 'wire:fetch:gone', kind: 'wire', from: 'fetch', to: 'gone', condition: 2 };
    const ghostEdges = (x: { edges: { id: string }[] }) => x.edges.filter((e) => e.id.startsWith('ghost:'));
    it('are drawn with ghost: true, draggable, not connectable', () => {
      const n = toFlow(b, view({ ghosts: [gstep] })).nodes.find((x) => x.id === 'ghost:step:gone')!;
      expect(n).toMatchObject({ type: 'step', draggable: true, connectable: false, zIndex: -1, className: 'ghost', position: { x: 5, y: 6 } });
      expect(n.data).toMatchObject({ ghost: true, ghostKey: 'step:gone', name: 'gone' });
    });
    it('a picked ghost node (and ghost wire) is selected, an unpicked one is not', () => {
      const v = view({ ghosts: [gstep, wire], picks: [{ kind: 'ghost', key: 'step:gone' }, { kind: 'step', id: 'fetch' }] });
      const r = toFlow(b, v);
      expect(r.nodes.find((x) => x.id === 'ghost:step:gone')!.selected).toBe(true);
      expect(r.nodes.find((x) => x.id === 'st:fetch')!.selected).toBe(true);
      expect(r.edges.find((x) => x.id === 'ghost:wire:fetch:gone')!.selected).toBe(false);
      expect(toFlow(b, view({ ghosts: [gstep] })).nodes.find((x) => x.id === 'ghost:step:gone')!.selected).toBe(false);
    });
    it('a ghost wire between a real and a ghost step is drawn', () => {
      const e = toFlow(b, view({ ghosts: [gstep, wire] })).edges.find((x) => x.id === 'ghost:wire:fetch:gone')!;
      expect(e).toMatchObject({ type: 'wire', source: 'st:fetch', target: 'ghost:step:gone', connectable: false, className: 'ghost' });
      expect(e.data).toMatchObject({ ghost: true, condition: 2 });
    });
    it('a ghost wire with a removed end is not drawn', () => {
      expect(ghostEdges(toFlow(b, view({ ghosts: [wire] })))).toEqual([]);
    });
    it('a ghost whose item is back on the board is not drawn', () => {
      expect(toFlow(b, view({ ghosts: [{ ...gstep, key: 'step:lonely', row: lonely }] })).nodes.some((x) => x.id.startsWith('ghost:'))).toBe(false);
    });
    it('flowIdOf names a ghost pick', () => {
      expect(flowIdOf({ kind: 'ghost', key: 'step:gone' })).toBe('ghost:step:gone');
    });
  });
  it('marks picked items selected, in pick order, a lone pick without a number', () => {
    const picks: Pick[] = [{ kind: 'step', id: 'expand' }, { kind: 'wire', from: 'fetch', to: 'expand' }, { kind: 'cache', id: 'c1' }];
    const { nodes, edges } = toFlow(b, view({ picks }));
    expect(nodes.filter((n) => n.selected).map((n) => [n.id, (n.data as { pick: unknown }).pick]).sort()).toEqual([
      ['ca:c1', { no: 3, solo: false }], ['st:expand', { no: 1, solo: false }]]);
    expect(edges.find((e) => e.id === 'wire:fetch:expand')!.selected).toBe(true);
    const solo = toFlow(b, view({ picks: [{ kind: 'entry', workflowId: 'daily', stepId: 'fetch' }] }));
    expect(solo.edges.find((e) => e.id === 'entry:daily:fetch')!.data).toMatchObject({ pick: { no: 1, solo: true } });
  });
  it("shows a workflow's run state", () => {
    const n = toFlow(b, view({ live: (id) => (id === 'daily' ? 'running' : 'unknown') })).nodes;
    expect(n.find((x) => x.id === 'wf:daily')!.data).toMatchObject({ status: 'running' });
    expect(n.find((x) => x.id === 'wf:hourly')!.data).toMatchObject({ status: 'unknown' });
  });
});

describe('toFlow: schemas mode', () => {
  const sb = schemaBoard();
  const schemaGhost: GhostItem = { key: 'schema:gone', kind: 'schema', row: { ...sb.schemas.so!, id: 'gone', name: 'gone', at: { x: 1500, y: 400 } } };
  it("without schemas the nodes and edges equal today's", () => {
    const today = toFlow({ ...sb, schemas: {} }, view());
    expect(toFlow(sb, view({ ghosts: [schemaGhost] }))).toEqual(today);
    expect(toFlow(sb, view({ schemas: false, hotSchema: 'sx', ghosts: [schemaGhost] }))).toEqual(today);
  });
  it('with schemas: one schema node per schema, one processor node per stepless processor, one schemaRef edge per ref with handles ref-<slot> → ref', () => {
    const { nodes, edges } = toFlow(sb, view({ schemas: true }));
    const schemas = nodes.filter((n) => n.type === 'schema');
    expect(schemas.map((n) => n.id).sort()).toEqual(['sc:sc', 'sc:sh', 'sc:so', 'sc:sx']);
    const sx = schemas.find((n) => n.id === 'sc:sx')!;
    expect([sx.width, sx.height, sx.position]).toEqual([190, 52, { x: 200, y: 400 }]);
    expect(sx.handles!.map((h) => `${h.type}:${h.id}:${h.position}`)).toEqual(['target:ref:top']);
    expect((sx.data as { row: { name: string }; state: string }).row.name).toBe('orders-in');
    expect(Object.fromEntries(schemas.map((n) => [n.id, (n.data as { state: string }).state]))).toEqual({ 'sc:sx': 'wired', 'sc:sc': 'wired', 'sc:sh': 'held', 'sc:so': 'orphan' });
    const procs = nodes.filter((n) => n.type === 'processor');
    expect(procs.map((n) => n.id)).toEqual(['pr:p2']);
    expect([procs[0]!.width, procs[0]!.height]).toEqual([210, 64]);
    expect(procs[0]!.handles!.map((h) => `${h.type}:${h.id}:${h.position}`)).toEqual(['source:ref-I:bottom', 'source:ref-O:bottom', 'source:ref-C:bottom']);
    expect(nodes.find((n) => n.id === 'st:fetch')!.handles!.map((h) => h.id)).toEqual(['in', 'out', 'ref-I', 'ref-O', 'ref-C']);
    const refs = edges.filter((e) => e.type === 'schemaRef');
    expect(refs.map((e) => [e.id, e.source, e.sourceHandle, e.target, e.targetHandle])).toEqual([
      ['sr:step:expand:input:sx', 'st:expand', 'ref-I', 'sc:sx', 'ref'],
      ['sr:step:expand:config:sc', 'st:expand', 'ref-C', 'sc:sc', 'ref'],
      ['sr:step:fetch:input:sx', 'st:fetch', 'ref-I', 'sc:sx', 'ref'],
      ['sr:step:fetch:config:sc', 'st:fetch', 'ref-C', 'sc:sc', 'ref'],
      ['sr:step:lonely:input:sx', 'st:lonely', 'ref-I', 'sc:sx', 'ref'],
      ['sr:step:lonely:config:sc', 'st:lonely', 'ref-C', 'sc:sc', 'ref'],
      ['sr:processor:p2:output:sh', 'pr:p2', 'ref-O', 'sc:sh', 'ref'],
    ]);
    expect(refs.every((e) => e.selectable === false && e.deletable === false)).toBe(true);
    expect(refs[0]!.data).toEqual({ slot: 'input', lit: false });
    // today's nodes and edges are all still there
    const today = toFlow(sb, view());
    expect(today.nodes.every((n) => nodes.some((m) => m.id === n.id))).toBe(true);
    expect(edges.filter((e) => e.type !== 'schemaRef')).toEqual(today.edges);
  });
  it('hotSchema lights only its edges', () => {
    const { edges } = toFlow(sb, view({ schemas: true, hotSchema: 'sc' }));
    const lit = edges.filter((e) => e.type === 'schemaRef' && (e.data as { lit: boolean }).lit).map((e) => e.id);
    expect(lit).toEqual(['sr:step:expand:config:sc', 'sr:step:fetch:config:sc', 'sr:step:lonely:config:sc']);
  });
  it('picked cards are selected and numbered; a schema ghost is a ghost schema node only in the mode', () => {
    expect(flowIdOf({ kind: 'schema', id: 'sx' })).toBe('sc:sx');
    expect(flowIdOf({ kind: 'processor', id: 'p2' })).toBe('pr:p2');
    const { nodes } = toFlow(sb, view({ schemas: true, picks: [{ kind: 'schema', id: 'so' }, { kind: 'processor', id: 'p2' }], ghosts: [schemaGhost] }));
    expect(nodes.find((n) => n.id === 'sc:so')!).toMatchObject({ selected: true, data: { pick: { no: 1, solo: false } } });
    expect(nodes.find((n) => n.id === 'pr:p2')!).toMatchObject({ selected: true, data: { pick: { no: 2, solo: false } } });
    const g = nodes.find((n) => n.id === 'ghost:schema:gone')!;
    expect(g).toMatchObject({ type: 'schema', className: 'ghost', position: { x: 1500, y: 400 }, data: { ghost: true, ghostKey: 'schema:gone' } });
  });
});
