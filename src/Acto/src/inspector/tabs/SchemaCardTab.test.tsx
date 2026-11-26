import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardState } from '../../design/board';
import { withSchemas } from './testBoard';
import { SchemaCardTab } from './SchemaCardTab';

const orphan = (b: BoardState): BoardState => ({ ...b, schemas: { ...b.schemas, 's-orph': { ...b.schemas['s-cfg']!, id: 's-orph', name: 'orph' } } });
/** p1 holds s-cfg and s-in, and no step uses it. */
const held = (): BoardState => { const b = withSchemas(); return { ...b, steps: Object.fromEntries(Object.entries(b.steps).map(([k, s]) => [k, { ...s, processorId: null }])) }; };

describe('SchemaCardTab', () => {
  it('an orphan shows the orphan note and no Used by chips', () => {
    render(<SchemaCardTab state={orphan(withSchemas())} id="s-orph" />);
    expect(screen.getByText('schema · orphan')).toBeInTheDocument();
    expect(screen.getByText('Orphan: no processor references this schema.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Used by')).toBeNull();
    expect(screen.queryByLabelText('Held by')).toBeNull();
  });
  it('a wired schema lists one chip per step and slot, and clicking one picks that step', () => {
    const go = vi.fn();
    const b = withSchemas();
    render(<SchemaCardTab state={b} id="s-cfg" go={go} />);
    expect(screen.getByText('schema · C of proc, C of proc, C of proc')).toBeInTheDocument();
    expect(screen.getByText('In use. Only orphans can be deleted.')).toBeInTheDocument();
    const chips = screen.getAllByRole('button', { name: /Open step/ });
    expect(chips).toHaveLength(3);
    expect(screen.getAllByText('Config schema · proc')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Open step expand' }));
    expect(go).toHaveBeenCalledWith([{ kind: 'step', id: 'expand' }]);
  });
  it('a held schema lists its processor under Held by', () => {
    const go = vi.fn();
    render(<SchemaCardTab state={held()} id="s-cfg" go={go} />);
    expect(screen.getByText('schema · held by proc 1.0.0')).toBeInTheDocument();
    expect(screen.getByText('Held by proc 1.0.0, a processor no step uses.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open processor proc' }));
    expect(go).toHaveBeenCalledWith([{ kind: 'processor', id: 'p1' }]);
  });
  it('every field is disabled', () => {
    render(<SchemaCardTab state={withSchemas()} id="s-cfg" />);
    for (const l of ['Name', 'Version', 'Description', 'Definition']) expect(screen.getByLabelText(l)).toBeDisabled();
    expect(screen.getByText('The definition is read-only: a change needs the processor restarted.')).toBeInTheDocument();
  });
});
