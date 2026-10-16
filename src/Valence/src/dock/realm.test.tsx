import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoHide } from './AutoHide';
import { anchorAt, Menu } from './Menu';
import { Picker } from './Picker';
import { Tooltips } from './Tooltip';

// A pop-out window is another JS realm: the nodes its document creates are not instances of the
// main window's Node or Element. An iframe gives jsdom such a second realm.
let frames: HTMLIFrameElement[] = [];
afterEach(() => { frames.forEach((f) => f.remove()); frames = []; vi.useRealTimers(); });

function otherRealm(): { win: Window; doc: Document } {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  frames.push(frame);
  const win = frame.contentWindow!;
  return { win, doc: win.document };
}

const press = (doc: Document, target: Element) =>
  target.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).MouseEvent('pointerdown', { bubbles: true }));

describe('overlays with nodes from another realm (a pop-out window)', () => {
  it('the test realm is really another one', () => {
    const { doc } = otherRealm();
    expect(doc.createElement('div') instanceof Element).toBe(false);
  });

  it('a menu closes on a press outside it on an element the pop-out created', () => {
    const { doc } = otherRealm();
    const outside = doc.body.appendChild(doc.createElement('button'));
    const onClose = vi.fn();
    render(<Menu label="Test" anchor={{ x: 0, y: 0, doc }} onClose={onClose} entries={[{ id: 'a', label: 'A', onSelect: () => {} }]} />);

    press(doc, outside);

    expect(onClose).toHaveBeenCalled();
  });

  it('a menu stays open on a press on the pop-out menu strip, and on itself', () => {
    const { doc } = otherRealm();
    const strip = doc.body.appendChild(doc.createElement('div'));
    strip.setAttribute('role', 'menubar');
    const onClose = vi.fn();
    render(<Menu label="Test" anchor={{ x: 0, y: 0, doc }} onClose={onClose} entries={[{ id: 'a', label: 'A', onSelect: () => {} }]} />);

    press(doc, strip.appendChild(doc.createElement('button')));
    press(doc, doc.querySelector('[role="menuitem"]')!);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('a picker closes on a press outside it on an element the pop-out created', () => {
    const { doc } = otherRealm();
    const outside = doc.body.appendChild(doc.createElement('div'));
    const onClose = vi.fn();
    render(<Picker items={[]} anchor={{ x: 0, y: 0, doc }} onPick={() => {}} onClose={onClose} />);

    press(doc, doc.querySelector('.picker input')!);
    expect(onClose).not.toHaveBeenCalled();
    press(doc, outside);

    expect(onClose).toHaveBeenCalled();
  });

  it('a tooltip shows for an element the pop-out created', () => {
    vi.useFakeTimers();
    const { win, doc } = otherRealm();
    const button = doc.body.appendChild(doc.createElement('button'));
    button.setAttribute('data-tip', 'Dock back into the main layout');
    render(<Tooltips windows={[win]} />);

    act(() => {
      button.dispatchEvent(new (win as unknown as typeof globalThis).MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
      vi.advanceTimersByTime(400);
    });

    const tip = doc.querySelector('[role="tooltip"]')!;
    expect(tip.textContent).toBe('Dock back into the main layout');
    expect(tip.className).toContain('on');
  });

  it('anchorAt opens in the document of a pop-out element', () => {
    const { doc } = otherRealm();
    const target = doc.body.appendChild(doc.createElement('div'));
    expect(anchorAt({ clientX: 1, clientY: 2, target }).doc).toBe(doc);
  });

  it('an open flyout stays open on a press inside it in a pop-out', () => {
    const { doc } = otherRealm();
    const host = doc.body.appendChild(doc.createElement('div'));
    const onClose = vi.fn();
    render(
      <AutoHide hidden={['inspector']} sideOf={() => 'right'} titleOf={() => 'Inspector'} flyId="inspector" fresh={new Set()} onOpen={() => {}} onClose={onClose} onPin={() => {}}
        renderPane={() => <div className="inside">x</div>} />,
      { container: host },
    );

    press(doc, doc.querySelector('.fly .inside')!);
    expect(onClose).not.toHaveBeenCalled();
    press(doc, doc.body);
    expect(onClose).toHaveBeenCalled();
  });
});
