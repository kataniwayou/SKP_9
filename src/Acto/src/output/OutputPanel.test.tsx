import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createOutputStore, OutputProvider } from './outputStore';
import { OutputPanel } from './OutputPanel';

describe('OutputPanel', () => {
  it('shows newest first when asked, and Clear all empties it', () => {
    const o = createOutputStore(null); o.log('first'); o.log('second');
    render(<OutputProvider store={o}><OutputPanel /></OutputProvider>);
    expect(screen.getByText('2 messages')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('first');
    fireEvent.click(screen.getByRole('button', { name: 'Newest first' }));
    expect(screen.getByRole('button', { name: 'Newest first' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('second');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByText('No messages.')).toBeInTheDocument();
  });

  it('counts one message in the singular and scrolls to the end in Newest last', () => {
    const o = createOutputStore(null);
    render(<OutputProvider store={o}><OutputPanel /></OutputProvider>);
    const body = screen.getByText('No messages.').parentElement as HTMLElement;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 500 });
    act(() => o.log('one'));
    expect(screen.getByText('1 message')).toBeInTheDocument();
    expect(body.scrollTop).toBe(500);
  });
});
