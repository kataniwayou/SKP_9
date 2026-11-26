import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LiveStoreProvider } from '../../live/LiveContext';
import { liveStub } from '../../test/liveStub';
import { withSchemas } from './testBoard';
import { ProcessorCardTab } from './ProcessorCardTab';

describe('ProcessorCardTab', () => {
  it('shows Source hash and Instance id disabled; its schema chips pick the schema', () => {
    const go = vi.fn();
    render(<LiveStoreProvider value={liveStub()}><ProcessorCardTab state={withSchemas()} id="p1" go={go} /></LiveStoreProvider>);
    expect(screen.getByText('processor · no step')).toBeInTheDocument();
    expect(screen.getByLabelText('Source hash')).toBeDisabled();
    expect(screen.getByLabelText('Instance id')).toBeDisabled();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByText('Read-only. Acto never changes, copies or deletes a processor.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open schema cfg' }));
    expect(go).toHaveBeenCalledWith([{ kind: 'schema', id: 's-cfg' }]);
  });
});
