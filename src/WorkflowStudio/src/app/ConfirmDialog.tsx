import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface DialogButton {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

/**
 * The studio's modal question (mockup v49 `.modal`), drawn in the window the action came from.
 * The primary button has focus, and Tab and Shift+Tab cycle within the buttons. While it is open, it
 * takes its window's keys first: Escape is Cancel wherever the focus is, and any other key outside it
 * is handled (default prevented), so the dock, which skips a handled key, never acts under the modal.
 */
export function ConfirmDialog({ doc, title, message, buttons, onCancel }: {
  doc: Document;
  title: string;
  message: ReactNode;
  buttons: readonly DialogButton[];
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const before = doc.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLButtonElement>('.btn.primary')?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, [doc]);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      const inside = e.target instanceof Node && box.current?.contains(e.target) === true;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel.current();
        return;
      }
      if (e.key === 'Tab') {
        const order = [...(box.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        if (order.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const at = inside ? order.indexOf(e.target as HTMLButtonElement) : -1;
        const next = at < 0 ? (e.shiftKey ? order.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + order.length) % order.length;
        order[next]!.focus();
        return;
      }
      if (!inside) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    doc.addEventListener('keydown', keydown, true);
    return () => doc.removeEventListener('keydown', keydown, true);
  }, [doc]);
  return createPortal(
    <div className="modal on">
      <div className="mbox" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId} ref={box}>
        <div className="mt" id={titleId}>{title}</div>
        <div className="mb" id={messageId}>{message}</div>
        <div className="mbtns">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <span className="spacer" />
          {buttons.map((b) => (
            <button key={b.label} type="button" className={b.primary ? 'btn primary' : 'btn'} onClick={b.onClick}>{b.label}</button>
          ))}
        </div>
      </div>
    </div>,
    doc.body,
  );
}
