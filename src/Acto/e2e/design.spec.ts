import { test, expect, type Page } from '@playwright/test';

// The only spec that writes to BaseAPI: it creates one throwaway workflow on the board, saves it, then
// deletes it in afterAll (by the id seen in the save request), whether or not an assertion failed.
let createdId: string | null = null;

test.afterAll(async ({ request }) => {
  if (!createdId) return;
  const r = await request.post(`/api/v1/workflows/${createdId}/delete`);
  expect(r.ok(), `deleting the throwaway workflow ${createdId}`).toBe(true);
});

/** Plays an HTML5 drag from `source` onto the page point (x, y) with the app's own payload. */
async function dragOnto(page: Page, source: ReturnType<Page['locator']>, x: number, y: number) {
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

test('design a workflow on the board, save it, and find it again after a reload', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByText(/Board loaded: \d+ workflows?/)).toBeVisible();
  await expect(page.getByTestId('toolbox-step').first()).toBeVisible();

  // the loaded board fills the view: pan it left by dragging a bare bit of the pane, leaving room on the right
  await expect(page.locator('.react-flow__node-workflow').first()).toBeVisible();
  await page.waitForTimeout(500);
  const pane = page.locator('.react-flow__pane');
  const pb = (await pane.boundingBox())!;
  const grab = { x: pb.x + pb.width - 20, y: pb.y + 30 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x - 400, grab.y, { steps: 10 });
  await page.mouse.up();

  // an empty spot on the board: a point (with room for a new frame) whose topmost element is the pane
  const spot = await page.evaluate(() => {
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
  expect(spot, 'an empty spot on the board').not.toBeNull();

  await dragOnto(page, page.getByRole('button', { name: /Workflow\s*drop on empty board/ }), spot!.x, spot!.y);
  const frame = page.locator('.react-flow__node-workflow', { hasText: /new-workflow-\d+/ });
  await expect(frame).toHaveCount(1);
  await expect(frame.locator('.nm')).toHaveText(/^new-workflow-\d+$/);
  const name = (await frame.locator('.nm').textContent())!;
  await expect(frame.locator('.unsaved-tag')).toBeVisible();

  // a step inside it, below the header
  const fb = (await frame.boundingBox())!;
  await dragOnto(page, page.getByTestId('toolbox-step').first(), fb.x + fb.width / 2, fb.y + fb.height * 0.6);
  const frameId = (await frame.getAttribute('data-id'))!.replace(/^wf:/, '');
  const step = page.locator(`.react-flow__node-step[data-id*=":${frameId}:"]`);
  await expect(step).toHaveCount(1);
  const drawn = (await step.boundingBox())!;

  // select the frame, press Save in its toolbar
  await frame.locator('.fh').click();
  const saveSent = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/workflows\/[^/]+\/design$/.test(r.url()));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const resp = await saveSent;
  createdId = /\/workflows\/([^/]+)\/design$/.exec(resp.url())![1];
  expect(createdId).toBe(frameId);

  await expect(page.getByText(`${name} saved`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${name}: Kibana diagram published`)).toBeVisible();
  await expect(frame.locator('.unsaved-tag')).toHaveCount(0);

  const before = (await frame.boundingBox())!;
  // the step stays where it was drawn: through the save, and through the reload
  const near = (a: { x: number; y: number }, b: { x: number; y: number }, what: string) => {
    for (const k of ['x', 'y'] as const) expect(Math.abs(a[k] - b[k]), `${what} ${k}`).toBeLessThanOrEqual(1);
  };
  near((await step.boundingBox())!, drawn, 'step after save');

  await page.reload();
  await expect(page.getByText(/Board loaded: \d+ workflows?/)).toBeVisible();
  const again = page.locator('.react-flow__node-workflow', { hasText: name });
  await expect(again).toBeVisible();
  await expect(again.locator('.unsaved-tag')).toHaveCount(0);
  const after = (await again.boundingBox())!;
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(after[k] - before[k]), k).toBeLessThanOrEqual(1);
  const stepAgain = page.locator(`.react-flow__node-step[data-id*=":${frameId}:"]`);
  await expect(stepAgain).toHaveCount(1);
  near((await stepAgain.boundingBox())!, drawn, 'step after reload');

  // a second step, then a real mouse drag from the first step's right handle onto the second step's body draws a wire
  // zoom in on the frame (mouse wheel) until its steps are big enough to grab
  const c0 = (await again.boundingBox())!;
  await page.mouse.move(c0.x + c0.width / 2, c0.y + c0.height / 2);
  for (let i = 0; i < 20 && (await again.boundingBox())!.width < 500; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(80); }
  await page.waitForTimeout(300);
  const fa = (await again.boundingBox())!;
  await dragOnto(page, page.getByTestId('toolbox-step').first(), fa.x + 8, fa.y + fa.height * 0.7);
  const steps = page.locator(`.react-flow__node-step[data-id*=":${frameId}:"]`);
  await expect(steps).toHaveCount(2);
  await expect(again.locator('.unsaved-tag')).toBeVisible();
  const edgesBefore = await page.locator('.react-flow__edge').count();
  const h = (await steps.nth(0).locator('.react-flow__handle.source').boundingBox())!;
  const body = (await steps.nth(1).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(edgesBefore + 1);

  const svg = await request.get(`/api/v1/workflows/${createdId}.svg`);
  expect(svg.status()).toBe(200);
  expect(await svg.text()).toContain('<svg');
});
