import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface DialogButton {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

/**
 * The studio's modal question (mockup v49 `.modal`), drawn in the window the action came from.
 * The primary button has focus; Escape is Cancel and goes no further (the dock skips a handled key).
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
  useEffect(() => {
    const before = doc.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLButtonElement>('.btn.primary')?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, [doc]);
  return createPortal(
    <div className="modal on" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
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
