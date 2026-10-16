import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { WorkflowSelect, type WorkflowItem } from './WorkflowSelect';

const ITEMS: WorkflowItem[] = [{ id: 'a', label: 'orders_1.0.0' }, { id: 'b', label: 'billing_2.0.0' }];

function Harness({ items = ITEMS, initial = [] as string[] }: { items?: WorkflowItem[]; initial?: string[] }) {
  const [selected, setSelected] = useState<readonly string[]>(initial);
  return <div><WorkflowSelect items={items} selected={selected} onChange={setSelected} /><p>outside</p></div>;
}

const pill = () => screen.getByRole('button', { name: /Workflows/ });
const option = (name: string) => screen.getByRole('option', { name: new RegExp(name) });

describe('WorkflowSelect', () => {
  it('says how many are highlighted and opens a multi-select list', () => {
    render(<Harness />);
    expect(pill()).toHaveTextContent('none highlighted');
    fireEvent.click(pill());
    expect(screen.getByRole('listbox', { name: 'Workflows' })).toHaveAttribute('aria-multiselectable', 'true');
    fireEvent.click(option('orders'));
    fireEvent.click(option('billing'));
    expect(option('orders')).toHaveAttribute('aria-selected', 'true');
    expect(pill()).toHaveTextContent('2 highlighted');
    // the list stays open for more picks; a second click takes one off
    fireEvent.click(option('orders'));
    expect(option('orders')).toHaveAttribute('aria-selected', 'false');
    expect(pill()).toHaveTextContent('1 highlighted');
  });

  it('filters by the search text and clears every pick', () => {
    render(<Harness initial={['a', 'b']} />);
    fireEvent.click(pill());
    fireEvent.change(screen.getByRole('textbox', { name: 'Search workflows' }), { target: { value: 'BILL' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['✓billing_2.0.0']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(pill()).toHaveTextContent('none highlighted');
  });

  it('closes on Esc and on a press outside', () => {
    render(<Harness />);
    fireEvent.click(pill());
    fireEvent.keyDown(option('orders'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(pill());
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('says there are no workflows when the list is empty', () => {
    render(<Harness items={[]} />);
    fireEvent.click(pill());
    expect(screen.getByText('No workflows yet.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
