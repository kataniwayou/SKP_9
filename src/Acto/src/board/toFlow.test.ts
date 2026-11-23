import { describe, expect, it } from 'vitest';
import { board } from '../design/boardFixtures';
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
    const w = (v: BoardView) => toFlow(b, v).edges.find((e) => e.id === 'wire:fetch:expand')!.data as { condition: number; running: boolean };
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
    const n = toFlow(b, view({ live })).nodes;
    const run = (id: string) => (n.find((x) => x.id === id)!.data as { running: boolean }).running;
    expect([run('st:fetch'), run('st:expand'), run('st:lonely')]).toEqual([true, true, false]);
  });
  it('a wire runs only when a running workflow reaches its source', () => {
    const w = (live: (id: string) => 'running' | 'stopped') => (toFlow(b, view({ live })).edges.find((e) => e.id === 'wire:fetch:expand')!.data as { running: boolean }).running;
    expect(w((id) => (id === 'hourly' ? 'running' : 'stopped'))).toBe(true);
    expect(w(() => 'stopped')).toBe(false);
  });
  it('a wire into a Never step never moves: it never fires, even while a running workflow reaches its source [user, 2026-11-23 item 4]', () => {
    const never = { ...b, steps: { ...b.steps, expand: { ...b.steps.expand!, entryCondition: 5 } } };
    const d = toFlow(never, view({ live: (id) => (id === 'hourly' ? 'running' : 'stopped') })).edges.find((e) => e.id === 'wire:fetch:expand')!.data as { condition: number; running: boolean };
    expect(d).toMatchObject({ condition: 5, running: false });
  });
  it('an entry arrow runs only while its workflow runs; cache lines never run', () => {
    const { edges } = toFlow(b, view({ live: (id) => (id === 'hourly' ? 'running' : 'stopped') }));
    const d = (id: string) => edges.find((e) => e.id === id)!.data as { running?: boolean };
    expect(d('entry:hourly:fetch').running).toBe(true);
    expect(d('entry:daily:fetch').running).toBe(false);
    expect(d('cache:daily:c1').running).toBeUndefined();
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
    it('are drawn with ghost: true, not draggable or connectable', () => {
      const n = toFlow(b, view({ ghosts: [gstep] })).nodes.find((x) => x.id === 'ghost:step:gone')!;
      expect(n).toMatchObject({ type: 'step', draggable: false, connectable: false, zIndex: -1, className: 'ghost', position: { x: 5, y: 6 } });
      expect(n.data).toMatchObject({ ghost: true, ghostKey: 'step:gone', name: 'gone' });
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
