import { describe, expect, it } from 'vitest';
import { board } from '../design/boardFixtures';
import type { Pick } from './selection';
import { toFlow, type BoardView } from './toFlow';

const view = (over: Partial<BoardView> = {}): BoardView => ({ workflow: null, picks: [], live: () => 'stopped', ...over });
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
  it("dims nothing with no workflow selected, and shows each step's version", () => {
    const { nodes, edges } = toFlow(b, view());
    expect([...nodes, ...edges].some(dim)).toBe(false);
    expect((nodes.find((n) => n.id === 'st:fetch')!.data as { footer: unknown }).footer).toEqual({ text: '1.0.0', accent: false });
  });
  it('with daily selected dims what it does not reach and shows its payload summary', () => {
    const { nodes, edges } = toFlow(b, view({ workflow: 'daily' }));
    const dimmed = [...nodes, ...edges].filter(dim).map((x) => x.id).sort();
    expect(dimmed).toEqual(['entry:hourly:fetch', 'st:lonely', 'wf:hourly']);
    const foot = (id: string) => (nodes.find((n) => n.id === id)!.data as { footer: unknown }).footer;
    expect(foot('st:fetch')).toEqual({ text: '0 keys', accent: true });
    expect(foot('st:expand')).toEqual({ text: 'no payload', accent: true });
    expect(foot('st:lonely')).toEqual({ text: '1.0.0', accent: false });
  });
  it("lights a workflow's caches and cache line", () => {
    const { nodes, edges } = toFlow(b, view({ workflow: 'hourly' }));
    expect(dim(nodes.find((n) => n.id === 'ca:c1')!)).toBe(true);
    expect(dim(edges.find((e) => e.id === 'cache:daily:c1')!)).toBe(true);
    expect(dim(toFlow(b, view({ workflow: 'daily' })).nodes.find((n) => n.id === 'ca:c1')!)).toBe(false);
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
