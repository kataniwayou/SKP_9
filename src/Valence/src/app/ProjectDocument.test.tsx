import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectData, ProjectResult } from '../api/project';
import project from '../test/fixtures/project.json';
import { ProjectDocument } from './ProjectDocument';
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
    render(<ProjectDocument workspace={createWorkspace()} read={ok} />);
    expect(screen.getByText('Reading the project…')).toBeInTheDocument();
    // the layout takes about half a second for the whole project
    const view = await screen.findByTestId('molecule', {}, { timeout: 5000 });
    expect(Number(view.dataset.atoms)).toBe(7 + 47 + 11 + 24 + 47 + 1);
    expect(view.dataset.lit).toBe('');
  });

  it('has no toolbar on the canvas and highlights nothing (the user, 2026-10-15)', async () => {
    render(<ProjectDocument workspace={createWorkspace()} read={ok} />);
    expect((await screen.findByTestId('molecule', {}, { timeout: 5000 })).dataset.lit).toBe('');
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: /Workflows/ })).toBeNull();
  });

  it('says why when BaseApi cannot be read, and Retry reads again', async () => {
    const read = vi.fn<() => Promise<ProjectResult>>()
      .mockResolvedValueOnce({ ok: false, message: 'BaseApi could not be read: Failed to fetch' })
      .mockImplementation(ok);
    render(<ProjectDocument workspace={createWorkspace()} read={read} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('BaseApi could not be read: Failed to fetch');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByTestId('molecule')).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

});
