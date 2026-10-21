import { expect, test, type OnScreen, type Pt, type Valence } from './valence';

// The canvas's mouse (spec §3b): a drag turns; Ctrl+drag on an atom relocates it, on empty canvas slides the picture (a
// lens shift: the camera stays); since 2026-10-19 a right drag is exactly a Ctrl+drag; the wheel zooms toward the centre.

const D = { x: 140, y: 80 };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Every atom's screen shift between two readings. */
const shifts = (before: Record<string, OnScreen>, after: Record<string, OnScreen>) =>
  Object.keys(before).map((k) => ({ key: k, dx: after[k]!.x - before[k]!.x, dy: after[k]!.y - before[k]!.y }));

async function relocate(v: Valence, key: string, how: { button?: 'right'; ctrl?: boolean }) {
  const p = await v.spot(key);
  const before = await v.atoms(), cam = await v.camera();
  await v.drag(p, { x: p.x + D.x, y: p.y + D.y }, how);
  await v.park();
  const after = await v.atoms();
  const moved = shifts(before, after);
  const self = moved.find((m) => m.key === key)!;
  const others = Math.max(...moved.filter((m) => m.key !== key).map((m) => Math.hypot(m.dx, m.dy)));
  return { self, others, camStill: (await v.camera()) === cam };
}

async function slide(v: Valence, how: { button?: 'right'; ctrl?: boolean }) {
  const e = await v.empty();
  const before = await v.atoms(), cam = await v.camera();
  await v.drag(e, { x: e.x + D.x, y: e.y - D.y }, how);
  await v.page.waitForTimeout(1200); // a trackball pan would still be drifting here
  const worst = Math.max(...shifts(before, await v.atoms()).map((m) => Math.hypot(m.dx - D.x, m.dy + D.y)));
  return { worst, camStill: (await v.camera()) === cam };
}

test('Ctrl+drag on an atom moves it with the pointer; nothing else moves; the camera stays', async ({ v }) => {
  const r = await relocate(v, v.key('wf', 'simple-abc'), { ctrl: true });
  expect(Math.abs(r.self.dx - D.x)).toBeLessThan(2);
  expect(Math.abs(r.self.dy - D.y)).toBeLessThan(2);
  expect(r.others).toBeLessThan(0.5);
  expect(r.camStill).toBe(true);
});

test('a right drag on an atom does exactly what Ctrl+drag does, with the four-way arrow', async ({ v }) => {
  const key = v.key('wf', 'sc-chain');
  const p = await v.spot(key);
  // the four-way arrow while dragging
  await v.page.mouse.move(p.x, p.y);
  await v.page.mouse.down({ button: 'right' });
  await v.page.mouse.move(p.x + 20, p.y + 10, { steps: 4 });
  expect(await v.gestureClasses()).toContain('movable');
  await v.page.mouse.up({ button: 'right' });
  await v.page.waitForTimeout(300);
  // and the move itself
  const r = await relocate(v, key, { button: 'right' });
  expect(Math.abs(r.self.dx - D.x)).toBeLessThan(2);
  expect(Math.abs(r.self.dy - D.y)).toBeLessThan(2);
  expect(r.others).toBeLessThan(0.5);
  expect(r.camStill).toBe(true);
});

test('Ctrl+drag on empty canvas slides every atom by the drag; the camera stays', async ({ v }) => {
  const r = await slide(v, { ctrl: true });
  expect(r.worst).toBeLessThan(1);
  expect(r.camStill).toBe(true);
});

test('a right drag on empty canvas slides the picture the same way, with the closed hand', async ({ v }) => {
  const e = await v.empty();
  await v.page.mouse.move(e.x, e.y);
  await v.page.mouse.down({ button: 'right' });
  await v.page.mouse.move(e.x + 30, e.y - 10, { steps: 4 });
  expect(await v.gestureClasses()).toContain('panning');
  await v.page.mouse.up({ button: 'right' });
  await v.page.waitForTimeout(300);
  const r = await slide(v, { button: 'right' });
  expect(r.worst).toBeLessThan(1);
  expect(r.camStill).toBe(true);
});

test('a plain drag turns the molecule; a right click pins nothing and opens no menu', async ({ v }) => {
  const cam = await v.camera();
  const e = await v.empty();
  await v.page.mouse.move(e.x, e.y);
  await v.page.mouse.down();
  await v.page.mouse.move(e.x + 80, e.y - 20, { steps: 10 });
  await v.page.waitForTimeout(400); // held still before letting go: no coast
  await v.page.mouse.up();
  await v.page.waitForTimeout(600);
  expect(await v.camera()).not.toBe(cam);

  const key = v.key('wf', 'simple-abc');
  const p = await v.spot(key);
  await v.page.mouse.click(p.x, p.y, { button: 'right' });
  await v.page.waitForTimeout(300);
  expect(await v.pinned()).toBeNull();
  await expect(v.page.locator('.dropdown[role="menu"]')).toHaveCount(0);
});

test('a right drag ends when the button is let go off the canvas: moving on moves nothing', async ({ v }) => {
  const key = v.key('wf', 'simple-abc');
  const p = await v.spot(key);
  const b = await v.box();
  await v.page.mouse.move(p.x, p.y);
  await v.page.mouse.down({ button: 'right' });
  await v.page.mouse.move(p.x + 60, p.y + 30, { steps: 5 });
  await v.page.mouse.move(b.x + b.width + 50, p.y, { steps: 5 });
  await v.page.mouse.up({ button: 'right' });
  await v.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
  await v.page.waitForTimeout(300);
  const before = await v.atom(key);
  await v.page.mouse.move(b.x + b.width / 2 + 100, b.y + b.height / 2 + 50, { steps: 5 });
  await v.page.waitForTimeout(300);
  expect(dist(before, await v.atom(key))).toBeLessThan(0.5);
  expect(await v.gestureClasses()).not.toContain('movable');
});

test('the wheel zooms toward the canvas centre: an atom slid to the centre stays there', async ({ v }) => {
  const key = v.key('wf', 'simple-abc');
  const b = await v.box();
  const centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  // slide the picture so the workflow sits at the centre
  const a = await v.atom(key);
  const e = await v.empty();
  await v.drag(e, { x: e.x + (centre.x - a.x), y: e.y + (centre.y - a.y) }, { ctrl: true });
  await v.page.waitForTimeout(300);
  expect(dist(await v.atom(key), centre)).toBeLessThan(2);
  const r0 = (await v.atom(key)).px;
  await v.page.mouse.move(centre.x + 200, centre.y + 120);
  for (let i = 0; i < 6; i++) { await v.page.mouse.wheel(0, -100); await v.page.waitForTimeout(150); }
  await v.page.waitForTimeout(800);
  const now = await v.atom(key);
  expect(now.px).toBeGreaterThan(r0 * 2);
  expect(dist(now, centre)).toBeLessThan(2);
});

test('zooming in shows more names; every arrow ends on its target ball', async ({ v }) => {
  // the atoms near the canvas centre, which stay in view when zoomed in: more of their names show up close
  const b = await v.box();
  const centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const near = Object.values(await v.atoms()).filter((a) => Math.abs(a.x - centre.x) < b.width / 6 && Math.abs(a.y - centre.y) < b.height / 6).map((a) => a.key);
  const named = () => v.page.evaluate((keys) => {
    const el = [...document.querySelectorAll('.mol')].find((e) => (e as unknown as { __molecule?: unknown }).__molecule) as unknown as {
      __molecule: { atoms: Map<string, { label: HTMLElement }> };
    };
    return keys.filter((k) => el.__molecule.atoms.get(k)!.label.style.display !== 'none').length;
  }, near);
  const far = await named();
  expect(far).toBeLessThan(near.length);
  await v.page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 6; i++) { await v.page.mouse.wheel(0, -100); await v.page.waitForTimeout(150); }
  await v.page.waitForTimeout(800);
  expect(await named()).toBeGreaterThan(far);

  // arrowheads (spec §3b, 2026-10-17): on screen every tip touches its target's disc — on the ball's face, or pulled back to
  // its outline when the ball hides it — within 1.5 px; arrows whose target is off screen are skipped
  const off = await v.page.evaluate(() => {
    type V3 = { clone(): V3; project(c: unknown): { x: number; y: number; z: number }; distanceTo(p: V3): number };
    const el = [...document.querySelectorAll('.mol')].find((e) => (e as unknown as { __molecule?: unknown }).__molecule) as unknown as HTMLElement & {
      __molecule: { camera: { fov: number; position: V3; updateMatrixWorld(): void }; arrows: { tip: V3; b: { pos: V3; atom: { key: string; type: string } } }[]; radiusOf(t: string): number };
    };
    const { camera, arrows, radiusOf } = el.__molecule; camera.updateMatrixWorld();
    const r = el.getBoundingClientRect();
    const screen = (p: V3) => { const v = p.clone().project(camera); return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height, z: v.z }; };
    const out: string[] = [];
    for (const x of arrows) {
      const c = screen(x.b.pos), t = screen(x.tip);
      if (c.x < 0 || c.x > r.width || c.y < 0 || c.y > r.height || c.z > 1) continue;
      const rad = radiusOf(x.b.atom.type), d = camera.position.distanceTo(x.b.pos);
      const px = ((rad * d) / Math.sqrt(d * d - rad * rad)) / ((2 * d * Math.tan((camera.fov * Math.PI) / 360)) / el.clientHeight);
      const gap = Math.hypot(t.x - c.x, t.y - c.y) - px;
      if (gap > 1.5) out.push(`${x.b.atom.key}: ${gap.toFixed(1)} px`);
    }
    return out;
  });
  expect(off).toEqual([]);
});
