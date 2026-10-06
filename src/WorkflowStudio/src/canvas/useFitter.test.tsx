import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fitterFor, useFitter } from './useFitter';

/** A stand-in document whose canvas measures every character as `px` wide and whose fonts load when told. */
function fakeDocument(px: number) {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => { release = resolve; });
  const doc = {
    fonts: { load: vi.fn(() => loaded), ready: loaded },
    createElement: () => ({ getContext: () => ({ font: '', measureText: (t: string) => ({ width: t.length * px }) }) }),
  } as unknown as Document;
  return { doc, release };
}

describe('fitterFor', () => {
  it('makes one fitter per document', () => {
    const { doc } = fakeDocument(1);
    expect(fitterFor(doc)).toBe(fitterFor(doc));
  });
});

describe('useFitter', () => {
  it('is null until the document fonts load, then measures in that document', async () => {
    const main = fakeDocument(2);
    const { result } = renderHook(() => useFitter(main.doc));
    expect(result.current).toBeNull();

    main.release();

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current!.width('abc', 'f')).toBe(6);
  });

  it('keeps the old fitter while a pop-out loads its fonts, then switches', async () => {
    const main = fakeDocument(2);
    main.release();
    const popout = fakeDocument(5);
    const { result, rerender } = renderHook(({ doc }) => useFitter(doc), { initialProps: { doc: main.doc } });
    await waitFor(() => expect(result.current).not.toBeNull());

    rerender({ doc: popout.doc });
    expect(result.current!.width('a', 'f')).toBe(2);

    popout.release();
    await waitFor(() => expect(result.current!.width('a', 'f')).toBe(5));
  });
});
