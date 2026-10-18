import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectData } from '../api/project';
import { createWorkspace, type Workspace } from '../app/workspace';
import { arrowKey, atomKey, buildMolecule } from '../molecule/model';
import { Inspector } from './Inspector';

const HASH = 'a'.repeat(64);
const data: ProjectData = {
  workflows: [],
  steps: [{ id: 's1', name: 'fetch', version: '1.0.0', description: null, processorId: 'p1', nextStepIds: [], entryCondition: 1, createdAt: '2026-08-15T21:37:03Z', createdBy: 'ana' }],
  processors: [{ id: 'p1', name: 'file-fetcher', version: '1.0.0', description: null, sourceHash: HASH, instanceId: null, inputSchemaId: 'c1', outputSchemaId: null, configSchemaId: null }],
  schemas: [{ id: 'c1', name: 'file-locator', version: '1.0.0', description: null, definition: '{"type":"object"}' }],
  assignments: [],
  caches: [],
};
const P = atomKey('proc', 'p1'), S = atomKey('step', 's1'), C = atomKey('schema', 'c1');

let ws: Workspace;
beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  ws = createWorkspace();
  ws.loaded(data, buildMolecule(data));
});
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe('Inspector', () => {
  it("shows a processor's health as its atom glows (the user, 2026-10-18)", () => {
    act(() => ws.pin(P));
    render(<Inspector workspace={ws} />);
    expect(screen.getByRole('status')).toHaveTextContent('Health Checking…');
    act(() => ws.livenessRead({ kind: 'known', processors: new Map([['p1', { live: true, healthy: 2, replicas: 2, reason: null }]]) }));
    expect(screen.getByRole('status')).toHaveTextContent('Health Healthy · 2 of 2 replicas healthy');
    expect(screen.getByRole('status')).toHaveClass('insp-health', 'healthy');
    act(() => ws.livenessRead({ kind: 'known', processors: new Map([['p1', { live: false, healthy: 0, replicas: 1, reason: 'no healthy replica (1 checked: 1 absent, 0 unhealthy, 0 stale, 0 malformed)' }]]) }));
    expect(screen.getByRole('status')).toHaveClass('unhealthy');
    act(() => ws.pin(S));
    expect(screen.queryByRole('status')).toBeNull(); // only processors have a health
  });

  it('says how to start when nothing is hovered or pinned', () => {
    render(<Inspector workspace={ws} />);
    expect(screen.getByText('Nothing selected. Hover an atom or arrow to preview it; click it to pin it.')).toBeInTheDocument();
  });

  it('previews a hovered atom read-only, and edits it once pinned', () => {
    render(<Inspector workspace={ws} />);
    act(() => ws.hover(P));
    expect(screen.getByText('PROCESSOR')).toBeInTheDocument();
    expect(screen.getByText('Preview · click the atom to pin it')).toBeInTheDocument();
    expect(input('Name')).toHaveValue('file-fetcher');
    expect(input('Name')).toHaveAttribute('readonly');
    act(() => { ws.pin(P); ws.hover(null); });
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(input('Name')).not.toHaveAttribute('readonly');
  });

  it('shows the writable fields open: source hash and instance id are writable', () => {
    act(() => ws.pin(P));
    render(<Inspector workspace={ws} />);
    expect(['Name', 'Version', 'Description', 'Source hash', 'Instance id'].map((l) => input(l).readOnly)).toEqual([false, false, false, false, false]);
    expect(input('Source hash')).toHaveValue(HASH);
  });

  it('keeps an edit virtual: the row is not changed, the field is marked, Revert drops it', () => {
    act(() => ws.pin(P));
    render(<Inspector workspace={ws} />);
    fireEvent.change(input('Name'), { target: { value: 'fetcher-2' } });
    expect(ws.get().edits[P]).toEqual({ name: 'fetcher-2' });
    expect(data.processors[0]!.name).toBe('file-fetcher');
    expect(screen.getByText('● Changed in Valence only, not applied')).toBeInTheDocument();
    expect(screen.getByText('Name')).toHaveClass('insp-edited');
    // typing the stored value again is no edit
    fireEvent.change(input('Name'), { target: { value: 'file-fetcher' } });
    expect(ws.get().edits).toEqual({});
    fireEvent.change(input('Version'), { target: { value: '2' } });
    expect(screen.getByText(/^Version does not match /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(ws.get().edits).toEqual({});
    expect(input('Version')).toHaveValue('1.0.0');
  });

  it('marks a bad cron, items or payload at once while BaseApi\'s dry run answers too (the user, 2026-10-18)', () => {
    const more: ProjectData = {
      ...data,
      workflows: [{ id: 'w1', name: 'flow', version: '1.0.0', description: null, entryStepIds: ['s1'], assignmentIds: ['a1'], cacheIds: ['k1'], cronExpression: null }],
      assignments: [{ id: 'a1', name: 'cfg', version: '1.0.0', description: null, stepId: 's1', schemaId: 'c1', payload: '{}' }],
      caches: [{ id: 'k1', name: 'store', version: '1.0.0', description: null, root: 'files', items: '{}' }],
    } as unknown as ProjectData;
    ws.loaded(more, buildMolecule(more));
    act(() => ws.judged({ kind: 'idle' }, null, true));
    expect(ws.get().dryRunWorks).toBe(true);
    render(<Inspector workspace={ws} />);
    const bad = (key: string, label: string, text: string) => {
      act(() => ws.pin(key));
      fireEvent.change(input(label), { target: { value: text } });
      expect(input(label)).toHaveAttribute('aria-invalid', 'true');
    };
    bad(atomKey('wf', 'w1'), 'Cron expression', '* *');
    expect(screen.getByText(/^CronExpression must be a valid 5- or 6-field cron expression/)).toBeInTheDocument();
    bad(atomKey('cache', 'k1'), 'Items', '{');
    bad(atomKey('asg', 'a1'), 'Payload', 'not json');
  });

  it("freezes the schema's definition while a processor uses it, and opens it once that arrow is deleted", () => {
    act(() => ws.pin(C));
    render(<Inspector workspace={ws} />);
    expect(input('Definition')).toHaveAttribute('readonly');
    expect(input('Definition')).toHaveValue('{\n  "type": "object"\n}');
    expect(screen.getByText(/^Frozen: used by file-fetcher \(input\)\./)).toHaveClass('fhint', 'locked');
    expect(input('Name').readOnly).toBe(false); // only the definition freezes
    const arrow = arrowKey(buildMolecule(data).arrows.find((x) => x.kind === 'input')!);
    act(() => { ws.remove(arrow); ws.pin(C); });
    expect(input('Definition')).not.toHaveAttribute('readonly');
    expect(screen.getByText(/^Open: no processor uses this schema in Valence\./)).toHaveClass('fhint', 'open');
    fireEvent.change(input('Definition'), { target: { value: '{"type":"array"}' } });
    expect(ws.get().edits[C]).toEqual({ definition: '{"type":"array"}' });
    expect(screen.getByText('● Changed in Valence only, not applied')).toBeInTheDocument();
    fireEvent.change(input('Definition'), { target: { value: '{"type":"list"}' } });
    expect(screen.getByText(/^Not a valid JSON Schema \(draft 2020-12\) — \/type: one of/)).toBeInTheDocument();
  });

  it('marks a definition edit frozen again when its processor arrow comes back', () => {
    ws = createWorkspace({ pinned: C, edits: { [C]: { definition: '{"type":"array"}' } } });
    ws.loaded(data, buildMolecule(data));
    render(<Inspector workspace={ws} />);
    expect(input('Definition')).toHaveAttribute('readonly');
    expect(input('Definition')).toHaveValue('{"type":"array"}');
    expect(screen.getByText(/^◐ Unfinished edit: the definition is frozen again/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(ws.get().edits).toEqual({});
  });

  it('keeps details and arrows in one closed show/hide section, details first', () => {
    act(() => ws.pin(S));
    const { unmount } = render(<Inspector workspace={ws} />);
    const toggle = screen.getByRole('button', { name: /Read-only/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Table')).toBeNull();
    fireEvent.click(toggle);
    const labels = [...document.querySelectorAll('.insp-ro .field label, .insp-ro .insp-divider')].map((e) => e.textContent);
    expect(labels).toEqual(['Table', 'Id', 'Created', 'Updated', 'Pointed at by', 'arrows', 'processor']);
    expect(screen.getByText('2026-08-15 21:37:03 · ana')).toBeInTheDocument();
    expect(screen.getByText('→ file-fetcher')).toBeInTheDocument();
    // the arrow fields are not editable fields
    expect(screen.queryByLabelText('Processor')).toBeNull();
    // open stays open
    unmount();
    render(<Inspector workspace={ws} />);
    expect(screen.getByRole('button', { name: /Read-only/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('offers the entry conditions BaseApi accepts', () => {
    act(() => ws.pin(S));
    render(<Inspector workspace={ws} />);
    expect([...(screen.getByLabelText('Entry condition') as HTMLSelectElement).options].map((o) => o.textContent))
      .toEqual(['PreviousCompleted', 'PreviousFailed', 'PreviousCancelled', 'Always', 'Never']);
  });
  it('shows a pinned arrow: its ends, whether it can be deleted and what that changes (spec §6b)', () => {
    ws.pin(arrowKey({ kind: 'input', from: P, to: C }));
    render(<Inspector workspace={ws} />);
    expect(screen.getByText('ARROW')).toBeInTheDocument();
    expect(screen.getByText('Processor file-fetcher')).toBeInTheDocument();
    expect(screen.getByText('Schema file-locator')).toBeInTheDocument();
    expect(screen.getByText(/✓ allowed/)).toBeInTheDocument();
    expect(screen.getByText(/schema-edge check passes on an empty slot/)).toBeInTheDocument();
  });

  it("says why a pinned atom cannot be deleted, and shows a deleted one as a read-only ghost", () => {
    ws.pin(P);
    const { rerender } = render(<Inspector workspace={ws} />);
    expect(screen.getByText(/✗ file-fetcher cannot be deleted/)).toBeInTheDocument();
    act(() => { ws.pin(C); });
    rerender(<Inspector workspace={ws} />);
    expect(screen.getByText(/✓ allowed — the arrow pointing at it goes with it/)).toBeInTheDocument();
    act(() => { ws.remove(C); });
    expect(screen.getByText('● Deleted in Valence only, not applied')).toBeInTheDocument();
    expect(input('Name').readOnly).toBe(true);
  });
});
