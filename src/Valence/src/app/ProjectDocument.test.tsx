import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SNAPSHOT, type RulesSource } from '../api/fields';
import type { ProjectData, ProjectResult } from '../api/project';
import type { DryRun } from '../api/validate';
import project from '../test/fixtures/project.json';
import { buildMolecule, reachOf } from '../molecule/model';
import { createHighlights } from './highlights';
import { litOf, ProjectDocument } from './ProjectDocument';
import { createWorkspace } from './workspace';

// WebGL does not exist in jsdom: the view is replaced by what it was given (the browser check draws the real one)
vi.mock('../molecule/MoleculeView', () => ({
  MoleculeView: ({ molecule, highlighted }: { molecule: { atoms: Map<string, unknown> }; highlighted: ReadonlySet<string> | null }) => (
    <div data-testid="molecule" data-atoms={molecule.atoms.size} data-lit={highlighted ? [...highlighted].sort().join(',') : ''} />
  ),
}));

const data = project as ProjectData;
const ok = (): Promise<ProjectResult> => Promise.resolve({ ok: true, data });
// no BaseApi in jsdom: the rules from the snapshot, and no dry run
const rulesStub = (): Promise<RulesSource> => Promise.resolve({ from: 'snapshot', fields: SNAPSHOT, note: 'Rules: the bundled snapshot (test).' });
const noDryRun = (): Promise<DryRun> => Promise.resolve({ kind: 'unavailable', reason: 'test', missing: true });
const offline = { readRules: rulesStub, check: noDryRun };

describe('ProjectDocument', () => {
  it('reads the project and draws every row', async () => {
    render(<ProjectDocument workspace={createWorkspace()} highlights={createHighlights([])} read={ok} {...offline} />);
    expect(screen.getByText('Reading the project…')).toBeInTheDocument();
    // the layout takes about half a second for the whole project
    const view = await screen.findByTestId('molecule', {}, { timeout: 5000 });
    expect(Number(view.dataset.atoms)).toBe(7 + 47 + 11 + 24 + 47 + 1);
    expect(view.dataset.lit).toBe('');
  });

  it('has no toolbar on the canvas and highlights nothing (the user, 2026-10-15)', async () => {
    render(<ProjectDocument workspace={createWorkspace()} highlights={createHighlights([])} read={ok} {...offline} />);
    expect((await screen.findByTestId('molecule', {}, { timeout: 5000 })).dataset.lit).toBe('');
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: /Workflows/ })).toBeNull();
  });

  it('fades what the picked workflows do not reach, and follows the filter (the user, 2026-10-16)', async () => {
    const molecule = buildMolecule(data);
    const [a, b] = [...molecule.atoms.values()].filter((x) => x.type === 'wf').map((x) => x.key);
    const highlights = createHighlights([a!]);
    render(<ProjectDocument workspace={createWorkspace()} highlights={highlights} read={ok} {...offline} />);
    const view = await screen.findByTestId('molecule', {}, { timeout: 5000 });
    expect(view.dataset.lit).toBe([...reachOf(molecule, a!)].sort().join(','));
    act(() => highlights.set([a!, b!]));
    expect(screen.getByTestId('molecule').dataset.lit).toBe([...new Set([...reachOf(molecule, a!), ...reachOf(molecule, b!)])].sort().join(','));
    act(() => highlights.set([]));
    expect(screen.getByTestId('molecule').dataset.lit).toBe('');
  });

  it('ignores picks that are not workflows of the project', () => {
    const molecule = buildMolecule(data);
    const step = [...molecule.atoms.values()].find((x) => x.type === 'step')!.key;
    expect(litOf(molecule, ['wf:gone', step])).toBeNull();
  });

  it('deletes the pinned atom on Delete, and Ctrl+Z / Ctrl+Y undo and redo it (the canvas keys)', async () => {
    const molecule = buildMolecule(data);
    const wf = [...molecule.atoms.values()].find((x) => x.type === 'wf')!.key;
    const ws = createWorkspace({ pinned: wf });
    const { container } = render(<ProjectDocument workspace={ws} highlights={createHighlights([])} read={ok} {...offline} />);
    await screen.findByTestId('molecule', {}, { timeout: 5000 });
    const panel = container.querySelector('.docpanel')!;
    fireEvent.keyDown(panel, { key: 'Delete' });
    expect(ws.get().removed.atoms).toEqual([wf]);
    fireEvent.keyDown(panel, { key: 'z', ctrlKey: true });
    expect(ws.get().removed.atoms).toEqual([]);
    fireEvent.keyDown(panel, { key: 'y', ctrlKey: true });
    expect(ws.get().removed.atoms).toEqual([wf]);
    fireEvent.keyDown(panel, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(ws.get().messages.at(-1)!.text).toBe('Nothing to redo.');
  });

  it('says why when BaseApi cannot be read, and Retry reads again', async () => {
    const read = vi.fn<() => Promise<ProjectResult>>()
      .mockResolvedValueOnce({ ok: false, message: 'BaseApi could not be read: Failed to fetch' })
      .mockImplementation(ok);
    render(<ProjectDocument workspace={createWorkspace()} highlights={createHighlights([])} read={read} {...offline} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('BaseApi could not be read: Failed to fetch');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByTestId('molecule')).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });


  it("asks BaseApi whether it has the dry run at load, then judges an edit by it and shows its answer", async () => {
    const ws = createWorkspace();
    const step = data.steps[0]!;
    const check = vi.fn(async (changes: readonly { op: string; table: string; id: string }[]): Promise<DryRun> => (changes.length === 0
      ? { kind: 'done', ok: true, results: [] }
      : { kind: 'done', ok: false, results: [{ index: 0, op: 'update', table: 'steps', id: step.id, ok: false, status: 400, problem: { title: 'Validation failed', errors: { Name: ['Name is taken (test).'] } } }] }));
    render(<ProjectDocument workspace={ws} highlights={createHighlights([])} read={ok} readRules={() => Promise.resolve({ from: 'baseapi', fields: SNAPSHOT, note: 'Rules: from BaseApi, GET /model/fields.' })} check={check} />);
    await screen.findByTestId('molecule');
    await vi.waitFor(() => expect(ws.get().dryRunWorks).toBe(true));
    expect(check).toHaveBeenCalledWith([]);
    expect(ws.get().messages.map((m) => m.text)).toContain('Rules: from BaseApi, GET /model/fields.');

    act(() => ws.edit(`step:${step.id}`, 'name', 'renamed', step.name));
    await vi.waitFor(() => expect(ws.get().dryRun.kind).toBe('done'), { timeout: 3000 });
    const sent = check.mock.calls.at(-1)![0];
    expect(sent).toEqual([expect.objectContaining({ op: 'update', table: 'steps', id: step.id })]);
    const state = ws.get().dryRun;
    expect(state.kind === 'done' && state.byAtom[`step:${step.id}`]).toEqual({ ok: false, fields: { name: ['Name is taken (test).'] }, other: [] });
    expect(ws.get().messages.at(-1)!.text).toMatch(/^Dry run by BaseApi: 1 of 1 refused — .* — Name: Name is taken \(test\)\.$/);
  });
});
