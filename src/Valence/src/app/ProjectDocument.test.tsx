import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectData, ProjectResult } from '../api/project';
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

describe('ProjectDocument', () => {
  it('reads the project and draws every row', async () => {
    render(<ProjectDocument workspace={createWorkspace()} highlights={createHighlights([])} read={ok} />);
    expect(screen.getByText('Reading the project…')).toBeInTheDocument();
    // the layout takes about half a second for the whole project
    const view = await screen.findByTestId('molecule', {}, { timeout: 5000 });
    expect(Number(view.dataset.atoms)).toBe(7 + 47 + 11 + 24 + 47 + 1);
    expect(view.dataset.lit).toBe('');
  });

  it('has no toolbar on the canvas and highlights nothing (the user, 2026-10-15)', async () => {
    render(<ProjectDocument workspace={createWorkspace()} highlights={createHighlights([])} read={ok} />);
    expect((await screen.findByTestId('molecule', {}, { timeout: 5000 })).dataset.lit).toBe('');
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: /Workflows/ })).toBeNull();
  });

  it('fades what the picked workflows do not reach, and follows the filter (the user, 2026-10-16)', async () => {
    const molecule = buildMolecule(data);
    const [a, b] = [...molecule.atoms.values()].filter((x) => x.type === 'wf').map((x) => x.key);
    const highlights = createHighlights([a!]);
    render(<ProjectDocument workspace={createWorkspace()} highlights={highlights} read={ok} />);
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
    const { container } = render(<ProjectDocument workspace={ws} highlights={createHighlights([])} read={ok} />);
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
    render(<ProjectDocument workspace={createWorkspace()} highlights={createHighlights([])} read={read} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('BaseApi could not be read: Failed to fetch');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByTestId('molecule')).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

});
