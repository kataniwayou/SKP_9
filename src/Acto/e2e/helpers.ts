import type { Page } from '@playwright/test';

/** Plays an HTML5 drag from `source` onto the page point (x, y) with the app's own payload. */
export async function dragOnto(page: Page, source: ReturnType<Page['locator']>, x: number, y: number) {
  const handle = await source.elementHandle();
  await page.evaluate(({ el, x, y }) => {
    const dt = new DataTransfer();
    const fire = (target: Element, type: string) =>
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    fire(el as Element, 'dragstart');
    const over = document.elementFromPoint(x, y)!;
    fire(over, 'dragenter');
    fire(over, 'dragover');
    fire(over, 'drop');
    fire(el as Element, 'dragend');
  }, { el: handle, x, y });
}

/** An empty spot on the board: a point (with room for a new frame) whose topmost element is the pane. */
export async function findEmptySpot(page: Page) {
  return page.evaluate(() => {
    const board = document.querySelector('.react-flow')!.getBoundingClientRect();
    const zoom = Number(/scale\(([\d.]+)\)/.exec((document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)?.[1] ?? 1);
    const w = 420 * zoom, h = 260 * zoom;
    for (let y = board.top + 80; y < board.bottom - h; y += 20) {
      for (let x = board.left + 20; x < board.right - w; x += 20) {
        let free = true;
        for (const dx of [0, w / 2, w]) for (const dy of [0, h / 2, h]) {
          const el = document.elementFromPoint(x + dx, y + dy);
          if (!el || !el.classList.contains('react-flow__pane')) free = false;
        }
        if (free) return { x, y };
      }
    }
    return null;
  });
}
