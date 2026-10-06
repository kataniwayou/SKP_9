import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest globals are off, so Testing Library does not unmount between tests by itself.
// The page keeps its session in this tab's sessionStorage by default, and writes it when it unmounts:
// cleared after the unmount, so no test inherits another's.
afterEach(() => { cleanup(); sessionStorage.clear(); });

// React Flow measures with ResizeObserver, reads transforms through DOMMatrixReadOnly and sizes
// nodes from offsetWidth/offsetHeight. jsdom has none of them; these shims are the ones React
// Flow's own testing guide uses. Nodes in this app always carry explicit width and height, so the
// style-based sizes below are the real ones.
class ResizeObserverShim {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    const el = target as HTMLElement;
    const contentRect = { width: parseFloat(el.style.width) || 1, height: parseFloat(el.style.height) || 1 };
    this.callback([{ target, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyShim {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}

globalThis.ResizeObserver = ResizeObserverShim as unknown as typeof ResizeObserver;
globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyShim as unknown as typeof DOMMatrixReadOnly;

Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { get() { return parseFloat((this as HTMLElement).style.height) || 1; } },
  offsetWidth: { get() { return parseFloat((this as HTMLElement).style.width) || 1; } },
});

(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
  ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
