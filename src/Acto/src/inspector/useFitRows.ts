import { useEffect, useState, type RefObject } from 'react';

const ROW_PX = 27;
const HEADER_PX = 24;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

export function fitRows(listHeightPx: number): number {
  const n = Math.floor((listHeightPx - HEADER_PX) / ROW_PX);
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Number.isFinite(n) ? n : MIN_ROWS));
}

/** Rows that fit the element's height; re-measured on resize (debounced 150 ms). */
export function useFitRows(ref: RefObject<HTMLElement | null>): number {
  const [rows, setRows] = useState(MIN_ROWS);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setRows(fitRows(el.clientHeight));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [ref]);
  return rows;
}
