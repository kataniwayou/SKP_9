import { describe, expect, it, vi } from 'vitest';
import type { LiveStatus } from '../api/liveStatus';
import type { Pick } from './picks';
import { toolbarFor, type ToolbarDeps } from './Toolbar';

const tri: Pick = { kind: 'workflow', id: 'w1' };
function deps(over: Partial<ToolbarDeps> = {}): ToolbarDeps {
  return {
    picks: [tri], run: () => 'stopped' as LiveStatus,
    start: vi.fn(), stop: vi.fn(), copy: vi.fn(), remove: vi.fn(),
    restore: vi.fn(), removeGhosts: vi.fn(),
    ...over,
  };
}
const labels = (p: Pick, d: ToolbarDeps) => toolbarFor(p, d)?.map((i) => i.label) ?? null;

describe('toolbarFor', () => {
  it('shows exactly the buttons per kind', () => {
    const d = deps();
    expect(labels(tri, d)).toEqual(['▶ Start', 'Copy', 'Delete']);
    expect(labels({ kind: 'step', id: 's' }, d)).toEqual(['Copy', 'Delete']);
    expect(labels({ kind: 'cache', id: 'c' }, d)).toEqual(['Copy', 'Delete']);
    expect(labels({ kind: 'wire', from: 'a', to: 'b' }, d)).toEqual(['Delete']);
    expect(labels({ kind: 'entry', workflowId: 'w1', stepId: 's' }, d)).toEqual(['Delete']);
    expect(labels({ kind: 'cacheLink', workflowId: 'w1', cacheId: 'c' }, d)).toEqual(['Delete']);
  });
  it('has no Save button anywhere: Save is board-wide', () => {
    for (const p of [tri, { kind: 'step', id: 's' } as Pick]) expect(labels(p, deps())).not.toContain('Save');
  });
  it('a triangle shows its toolbar only while it is picked', () => {
    expect(toolbarFor(tri, deps({ picks: [] }))).toBeNull();
    expect(toolbarFor(tri, deps({ picks: [{ kind: 'step', id: 's' }] }))).toBeNull();
  });
  it('Stop for a running workflow, Start disabled while the run state is not known', () => {
    expect(labels(tri, deps({ run: () => 'running' }))).toEqual(['■ Stop', 'Copy', 'Delete']);
    expect(toolbarFor(tri, deps({ run: () => 'checking' }))![0]).toMatchObject({ label: '▶ Start', disabled: true });
  });
  it('the buttons call their actions', () => {
    const d = deps();
    toolbarFor(tri, d)![0]!.onClick(); expect(d.start).toHaveBeenCalledWith('w1');
    toolbarFor(tri, d)![1]!.onClick(); expect(d.copy).toHaveBeenCalledWith({ kind: 'workflow', id: 'w1' });
    toolbarFor(tri, d)![2]!.onClick(); expect(d.remove).toHaveBeenCalledWith(tri); // a ghost, like a step's [user, 2026-11-23]
    const step: Pick = { kind: 'step', id: 's' };
    toolbarFor(step, d)![0]!.onClick(); expect(d.copy).toHaveBeenCalledWith({ kind: 'step', id: 's' });
    toolbarFor({ kind: 'cache', id: 'c' }, d)![0]!.onClick(); expect(d.copy).toHaveBeenCalledWith({ kind: 'cache', id: 'c' });
    toolbarFor(step, d)![1]!.onClick(); expect(d.remove).toHaveBeenCalledWith(step);
    toolbarFor(tri, deps({ run: () => 'running', stop: d.stop }))![0]!.onClick(); expect(d.stop).toHaveBeenCalledWith('w1');
  });
  it('a ghost has Restore · Remove, each acting on its key', () => {
    const d = deps();
    const g: Pick = { kind: 'ghost', key: 'step:s' };
    expect(labels(g, d)).toEqual(['Restore', 'Remove']);
    toolbarFor(g, d)![0]!.onClick(); expect(d.restore).toHaveBeenCalledWith(['step:s']);
    toolbarFor(g, d)![1]!.onClick(); expect(d.removeGhosts).toHaveBeenCalledWith(['step:s']);
  });
});
