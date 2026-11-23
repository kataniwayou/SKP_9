import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import { HideButton } from './HideButton';
import { Shell } from './Shell';

const ui = (storage?: Storage | null) =>
  <Shell toolbox="T" board="B" inspector="I" output="O" chat="C" storage={storage} />;

describe('Shell', () => {
  it('resets a splitter on double-click', () => {
    render(ui(null));
    const sep = screen.getAllByRole('separator')[0]!;
    fireEvent.pointerDown(sep, { clientX: 216 }); fireEvent.pointerMove(sep, { clientX: 316 }); fireEvent.pointerUp(sep);
    expect(screen.getByTestId('shell')).toHaveStyle({ '--tw': '300px' });
    fireEvent.doubleClick(sep); expect(screen.getByTestId('shell')).toHaveStyle({ '--tw': '200px' });
  });

  it('renders the five panels and four separators in order', () => {
    render(ui(null));
    for (const p of ['toolbox', 'board', 'inspector', 'output', 'chat'])
      expect(document.querySelector(`[data-panel="${p}"]`)).not.toBeNull();
    const seps = screen.getAllByRole('separator');
    expect(seps.map((s) => s.getAttribute('aria-orientation'))).toEqual(['vertical', 'vertical', 'horizontal', 'vertical']);
  });

  it('clamps drags, moves the other splitters the right way and remembers sizes', () => {
    const st = memoryStorage();
    const { unmount } = render(ui(st));
    const [s1, s2, s3] = screen.getAllByRole('separator') as [HTMLElement, HTMLElement, HTMLElement];
    fireEvent.pointerDown(s1, { clientX: 0 }); fireEvent.pointerMove(s1, { clientX: 1000 }); fireEvent.pointerUp(s1);
    fireEvent.pointerDown(s2, { clientX: 500 }); fireEvent.pointerMove(s2, { clientX: 400 }); fireEvent.pointerUp(s2);
    fireEvent.pointerDown(s3, { clientY: 500 }); fireEvent.pointerMove(s3, { clientY: 450 }); fireEvent.pointerUp(s3);
    const shell = screen.getByTestId('shell');
    expect(shell).toHaveStyle({ '--tw': '340px', '--iw': '400px', '--bh': '240px' });
    unmount();
    render(ui(st));
    expect(screen.getByTestId('shell')).toHaveStyle({ '--tw': '340px', '--iw': '400px', '--bh': '240px' });
  });

  it('ignores moves when no drag started', () => {
    render(ui(null));
    const sep = screen.getAllByRole('separator')[0]!;
    fireEvent.pointerMove(sep, { clientX: 900 });
    expect(screen.getByTestId('shell')).toHaveStyle({ '--tw': '200px' });
  });

  it('hides a panel from its header button to a tab on its edge, and the tab shows it again at its old size', () => {
    const st = memoryStorage();
    render(<Shell toolbox={<HideButton />} board="B" inspector={<HideButton />} output={<HideButton />} chat={<HideButton />} storage={st} />);
    const shell = screen.getByTestId('shell');
    fireEvent.click(screen.getByRole('button', { name: 'Hide toolbox' }));
    expect(document.querySelector('[data-panel="toolbox"]')).not.toBeVisible();
    expect(shell).toHaveStyle({ '--tw': '26px' });
    expect(screen.queryByRole('separator', { name: 'Resize toolbox' })).toBeNull();
    fireEvent.click(screen.getByTitle('Show toolbox'));
    expect(document.querySelector('[data-panel="toolbox"]')).toBeVisible();
    expect(shell).toHaveStyle({ '--tw': '200px' });
    expect(screen.queryByTitle('Show toolbox')).toBeNull();
  });

  it('both bottom panels hidden: the bottom row shrinks to a strip of their two tabs', () => {
    render(<Shell toolbox="T" board="B" inspector="I" output={<HideButton />} chat={<HideButton />} storage={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide output' }));
    expect(document.querySelector('.bottom')).toHaveClass('no-output');
    fireEvent.click(screen.getByRole('button', { name: 'Hide chat' }));
    expect(document.querySelector('.bottom')).toHaveClass('strip');
    expect(screen.getByTestId('shell')).toHaveStyle({ '--bh': '26px' });
    expect(screen.getByTitle('Show output')).toHaveClass('bottom');
    expect(screen.getByTitle('Show chat')).toHaveClass('bottom');
  });

  it('Board only hides every panel; Restore layout puts back the layout from before, kept across a reload', () => {
    const st = memoryStorage();
    const { unmount } = render(<Shell toolbox="T" board="B" inspector={<HideButton />} output="O" chat="C" storage={st} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide inspector' }));
    fireEvent.click(screen.getByRole('button', { name: 'Board only' }));
    for (const p of ['toolbox', 'inspector', 'output', 'chat']) expect(document.querySelector(`[data-panel="${p}"]`)).not.toBeVisible();
    unmount();
    render(<Shell toolbox="T" board="B" inspector="I" output="O" chat="C" storage={st} />); // remembered across a reload
    fireEvent.click(screen.getByRole('button', { name: 'Restore layout' }));
    expect(document.querySelector('[data-panel="inspector"]')).not.toBeVisible();
    for (const p of ['toolbox', 'output', 'chat']) expect(document.querySelector(`[data-panel="${p}"]`)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Board only' })).toBeInTheDocument();
  });

  it('in Board only, showing a panel from its tab ends Board only: the button reads Board only again', () => {
    render(<Shell toolbox="T" board="B" inspector="I" output="O" chat="C" storage={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Board only' }));
    fireEvent.click(screen.getByTitle('Show output'));
    expect(document.querySelector('[data-panel="output"]')).toBeVisible();
    for (const p of ['toolbox', 'inspector', 'chat']) expect(document.querySelector(`[data-panel="${p}"]`)).not.toBeVisible();
    expect(screen.queryByRole('button', { name: 'Restore layout' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Board only' })); // a fresh Board only keeps this layout
    fireEvent.click(screen.getByRole('button', { name: 'Restore layout' }));
    expect(document.querySelector('[data-panel="output"]')).toBeVisible();
    expect(document.querySelector('[data-panel="chat"]')).not.toBeVisible();
  });

  it("a hidden Output's tab gets a dot when something new arrives, gone once shown; the Inspector's tab names what it is on", () => {
    const ui2 = (mark: number) => <Shell toolbox="T" board="B" inspector={<HideButton />} output={<HideButton />} chat="C" storage={null}
      marks={{ output: mark }} inspectorNote="normalizer" />;
    const { rerender } = render(ui2(1));
    fireEvent.click(screen.getByRole('button', { name: 'Hide output' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide inspector' }));
    expect(screen.getByTitle('Show inspector')).toHaveTextContent('Inspector · normalizer');
    expect(screen.queryByTestId('new-output')).toBeNull();
    rerender(ui2(2));
    expect(screen.getByTestId('new-output')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Show output'));
    fireEvent.click(screen.getByRole('button', { name: 'Hide output' }));
    expect(screen.queryByTestId('new-output')).toBeNull();
  });

  it('writes the sizes once, on pointer-up, not on every move', () => {
    const st = memoryStorage();
    const set = vi.spyOn(st, 'setItem');
    render(ui(st));
    const sep = screen.getAllByRole('separator')[0]!;
    fireEvent.pointerDown(sep, { clientX: 0 });
    for (const x of [10, 20, 30, 40, 50]) fireEvent.pointerMove(sep, { clientX: x });
    expect(screen.getByTestId('shell')).toHaveStyle({ '--tw': '250px' });
    expect(set).not.toHaveBeenCalled();
    fireEvent.pointerUp(sep);
    expect(set).toHaveBeenCalledTimes(1);
    expect(JSON.parse(st.getItem('acto.panels')!).tools).toBe(250);
  });
});
