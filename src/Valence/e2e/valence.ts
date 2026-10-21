/* eslint-disable @typescript-eslint/no-explicit-any -- the page's scene is read through the dev-only hook, untyped */
import { expect, test as base, type Page } from '@playwright/test';
import { standIn, type StandIn } from './standin';

export { expect };

/** An atom kind, as the canvas keys it (`<type>:<id>`). */
export type AtomType = 'wf' | 'step' | 'proc' | 'schema' | 'asg' | 'cache';
const TABLE: Record<AtomType, keyof StandIn['project']> = {
  wf: 'workflows', step: 'steps', proc: 'processors', schema: 'schemas', asg: 'assignments', cache: 'caches',
};

/** An atom as it stands on screen: its centre in client px, its on-screen radius and its depth (-1 near … 1 far). */
export interface OnScreen { key: string; name: string; type: AtomType; x: number; y: number; z: number; px: number }
export interface Pt { x: number; y: number }

/** The canvas element that carries the scene hook (the Canvas's flyout may draw a second one). */
const MOL = `[...document.querySelectorAll('.mol')].find((e) => e.__molecule)`;

/**
 * Valence opened on a fresh session (no dock, view or draft kept), with BaseApi stood in (or the cluster's, read only). The
 * helpers act as a user does: real mouse moves, presses and drags, keys on the focused canvas.
 */
export class Valence {
  /** Page errors and console errors, for the after-test check. */
  readonly errors: string[] = [];
  constructor(readonly page: Page, readonly api: StandIn) {
    page.on('pageerror', (e) => this.errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource|404/.test(m.text())) this.errors.push(m.text().slice(0, 300));
    });
  }

  static async open(page: Page): Promise<Valence> {
    const v = new Valence(page, await standIn(page));
    await page.goto('/');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload();
    await v.ready();
    return v;
  }

  /** Waits for the molecule to be drawn and laid out (the springs settle in under half a second). */
  async ready() {
    await this.page.waitForFunction(() => [...document.querySelectorAll('.mol')].some((e: any) => e.__molecule?.atoms.size > 0), null, { timeout: 60_000 });
    await this.page.waitForTimeout(1500);
  }

  /** A page refresh, as F5 in the browser (the session is kept). */
  async refresh() {
    await this.page.reload();
    await this.ready();
  }

  // ---------- the project ----------

  /** An atom's key from its row's name (the first row of that name). */
  key(type: AtomType, name: string): string {
    const row = this.api.project[TABLE[type]].find((r) => r.name === name);
    if (!row) throw new Error(`no ${type} named ${name} in the project`);
    return `${type}:${row.id}`;
  }

  /** The canvas's bounding box. */
  async box() {
    const b = await this.page.locator('.mol').first().boundingBox();
    if (!b) throw new Error('the canvas is not shown');
    return b;
  }

  // ---------- the scene, read through the dev-only hook ----------

  /** Every atom where it stands on screen now. */
  atoms(): Promise<Record<string, OnScreen>> {
    return this.page.evaluate((sel) => {
      const el = eval(sel); const { camera, atoms, radiusOf } = el.__molecule; camera.updateMatrixWorld();
      const r = el.getBoundingClientRect(), out: Record<string, unknown> = {};
      atoms.forEach((a: any, k: string) => {
        const v = a.pos.clone().project(camera), rad = radiusOf(a.atom.type), d = camera.position.distanceTo(a.pos);
        const px = ((rad * d) / Math.sqrt(d * d - rad * rad)) / ((2 * d * Math.tan((camera.fov * Math.PI) / 360)) / el.clientHeight);
        out[k] = { key: k, name: a.atom.name, type: a.atom.type, x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height, z: v.z, px };
      });
      return out;
    }, MOL) as Promise<Record<string, OnScreen>>;
  }

  async atom(key: string): Promise<OnScreen> {
    const a = (await this.atoms())[key];
    if (!a) throw new Error(`atom ${key} is not on the canvas`);
    return a;
  }

  /** Every atom's place in the scene (scene units). */
  places(): Promise<Record<string, [number, number, number]>> {
    return this.page.evaluate((sel) => {
      const out: Record<string, number[]> = {};
      eval(sel).__molecule.atoms.forEach((a: any, k: string) => { out[k] = a.pos.toArray(); });
      return out;
    }, MOL) as Promise<Record<string, [number, number, number]>>;
  }

  /** The camera's position, rounded, as one string (equal strings: the camera did not move). */
  camera(): Promise<string> {
    return this.page.evaluate((sel) => eval(sel).__molecule.camera.position.toArray().map((n: number) => n.toFixed(5)).join(), MOL);
  }

  /** Whether the canvas draws this arrow (`kind`, tail key, head key). */
  arrowOn(kind: string, from: string, to: string): Promise<boolean> {
    return this.page.evaluate(([sel, kind, from, to]) => eval(sel!).__molecule.arrows
      .some((x: any) => x.arrow.kind === kind && x.a.atom.key === from && x.b.atom.key === to), [MOL, kind, from, to]);
  }

  /** The halo breathing behind the atom: its colour (#rrggbb), or null when it has none. */
  halo(key: string): Promise<string | null> {
    return this.page.evaluate(([sel, key]) => {
      const { atoms, halos } = eval(sel!).__molecule; const h = halos.get(atoms.get(key));
      return h && h.visible ? '#' + h.material.uniforms.color.value.getHexString() : null;
    }, [MOL, key]);
  }

  /** A processor's health glow inside its outline: its colour and strength (0: none). */
  glow(key: string): Promise<{ color: string; glow: number } | null> {
    return this.page.evaluate(([sel, key]) => eval(sel!).__molecule.glowOf(key), [MOL, key]);
  }

  /**
   * The atom under a client point, as the canvas picks it (its bridge, loaded from the dev server's own module, so the
   * same instance the app uses).
   */
  atomAt(x: number, y: number): Promise<string | null> {
    return this.page.evaluate(async ([x, y]) => {
      const url = '/src/molecule/bridge.ts';
      const { canvasBridge } = await import(/* @vite-ignore */ url);
      return canvasBridge.get()?.atomAt(x, y) ?? null;
    }, [x, y]);
  }

  /** Points on screen over this atom that no nearer atom covers: its centre first, then points on its disc. */
  async spots(key: string): Promise<Pt[]> {
    const a = await this.atom(key);
    const tries: Pt[] = [{ x: a.x, y: a.y }];
    for (const f of [0.5, 0.8]) for (let i = 0; i < 8; i++) tries.push({ x: a.x + Math.cos((i * Math.PI) / 4) * a.px * f, y: a.y + Math.sin((i * Math.PI) / 4) * a.px * f });
    const out: Pt[] = [];
    for (const p of tries) if ((await this.atomAt(p.x, p.y)) === key) out.push(p);
    if (!out.length) throw new Error(`atom ${a.name} (${key}) is covered by other atoms at ${a.x.toFixed(0)}, ${a.y.toFixed(0)}`);
    return out;
  }

  /** A point on screen where a press lands on this atom (its centre, else a point on its disc that no nearer atom covers). */
  async spot(key: string): Promise<Pt> { return (await this.spots(key))[0]!; }

  /** A point on the canvas with no atom under it, away from the edges (searched from the given fractions of the box). */
  async empty(fx = 0.06, fy = 0.9): Promise<Pt> {
    const b = await this.box();
    for (let i = 0; i < 40; i++) {
      const p = { x: b.x + b.width * (fx + 0.02 * (i % 10)), y: b.y + b.height * (fy - 0.04 * Math.floor(i / 10)) };
      if ((await this.atomAt(p.x, p.y)) === null) return p;
    }
    throw new Error('no empty spot on the canvas');
  }

  // ---------- the mouse and the keys ----------

  /** Moves the pointer off every atom (the canvas's top-right corner), so no hover preview takes the Inspector. */
  async park() {
    const b = await this.box();
    await this.page.mouse.move(b.x + b.width - 8, b.y + 8, { steps: 3 });
    await this.page.waitForTimeout(250);
  }

  /** A click on the atom: it is pinned. A thin arrow in front of a small atom takes the click: then the next point on it. */
  async pin(key: string) {
    for (const p of await this.spots(key)) {
      await this.page.mouse.move(p.x, p.y, { steps: 4 });
      await this.page.mouse.click(p.x, p.y);
      await this.page.waitForTimeout(350);
      if ((await this.pinned()) === key) return;
    }
    expect(await this.pinned(), `pinned ${key}`).toBe(key);
  }

  /** A click on an arrow's shaft (tried along it, between atoms): it is pinned. `kind|from|to`, as the canvas keys it. */
  async pinArrow(kind: string, from: string, to: string) {
    const key = `${kind}|${from}|${to}`;
    const a = await this.atom(from), b = await this.atom(to);
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.45, 0.55, 0.35, 0.65]) {
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      if ((await this.atomAt(x, y)) !== null) continue;
      await this.page.mouse.move(x, y, { steps: 3 });
      await this.page.mouse.click(x, y);
      await this.page.waitForTimeout(300);
      if ((await this.pinned()) === key) return;
    }
    throw new Error(`the arrow ${key} could not be clicked along its shaft`);
  }

  /** A key pressed with the canvas focused, where Delete, Ctrl+Z and Ctrl+Y act. */
  async canvasKey(combo: string) {
    await this.page.locator('.mol').first().focus();
    await this.page.keyboard.press(combo);
    await this.page.waitForTimeout(350);
  }

  /** A drag from a point to a point with the button held (left by default), in small steps as a hand moves. */
  async drag(from: Pt, to: Pt, opts: { button?: 'left' | 'right'; ctrl?: boolean; steps?: number } = {}) {
    const { mouse, keyboard } = this.page;
    await mouse.move(from.x, from.y, { steps: 3 });
    if (opts.ctrl) await keyboard.down('Control');
    await mouse.down({ button: opts.button ?? 'left' });
    await mouse.move(from.x + (to.x - from.x) / 2, from.y + (to.y - from.y) / 2, { steps: opts.steps ?? 6 });
    await mouse.move(to.x, to.y, { steps: opts.steps ?? 6 });
    await this.page.waitForTimeout(80);
    await mouse.up({ button: opts.button ?? 'left' });
    if (opts.ctrl) await keyboard.up('Control');
    await this.page.waitForTimeout(300);
  }

  /** The canvas element's gesture classes now (movable, panready, panning, turning). */
  gestureClasses(): Promise<string[]> {
    return this.page.evaluate((sel) => [...eval(sel).classList as DOMTokenList].filter((c) => ['movable', 'panready', 'panning', 'turning'].includes(c)), MOL);
  }

  // ---------- the panes ----------

  /** The Output pane's lines, without their times. */
  async output(): Promise<string[]> {
    return (await this.page.locator('[data-pane="output"] .out-line').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim().replace(/^\d\d:\d\d:\d\d /, ''));
  }

  /**
   * The latest line an action wrote: BaseApi's dry run (600 ms after a change) and the health poll write on their own time,
   * so their lines are passed over.
   */
  async lastLine(): Promise<string> {
    return (await this.output()).filter((t) => !/^(Dry run by BaseApi|Health:)/.test(t)).at(-1) ?? '';
  }

  /** The latest Output line matching, or '' (for a readable failure). */
  async said(re: RegExp): Promise<string> { return (await this.output()).reverse().find((t) => re.test(t)) ?? ''; }

  /** The session Valence keeps in this tab (sessionStorage). */
  session(): Promise<Record<string, any>> {
    return this.page.evaluate(() => JSON.parse(sessionStorage.getItem('skp.valence.session') ?? '{}'));
  }

  /** What is deleted in Valence (empty lists when nothing is). */
  async removed(): Promise<{ atoms: string[]; arrows: string[] }> {
    const r = (await this.session()).removed;
    return { atoms: r?.atoms ?? [], arrows: r?.arrows ?? [] };
  }

  async pinned(): Promise<string | null> { return (await this.session()).pinned ?? null; }

  inspector() { return this.page.locator('[data-pane="inspector"]'); }

  /** The pinned atom's field in the Inspector (`#insp-<field>`). */
  field(name: string) { return this.page.locator(`[data-pane="inspector"] #insp-${name}`); }

  /** Types into the pinned atom's fields, once the Inspector shows its editor (not a hover preview). */
  async fill(fields: Record<string, string>) {
    await this.park();
    const first = this.field(Object.keys(fields)[0]!);
    await expect(first).toBeEditable();
    for (const [f, value] of Object.entries(fields)) {
      const el = this.field(f);
      if ((await el.evaluate((e) => e.tagName)) === 'SELECT') await el.selectOption(value);
      else await el.fill(value);
      await this.page.waitForTimeout(120);
    }
  }

  /**
   * Waits for BaseApi's dry run that follows a change (600 ms after the virtual state settles): one more dry run than
   * `before`, answered.
   */
  async dryRunAfter(before: number) {
    await expect.poll(() => this.api.dryRuns.length, { timeout: 15_000 }).toBeGreaterThan(before);
    await expect(this.page.locator('[data-pane="inspector"] .insp-dry.checking')).toHaveCount(0);
    await this.page.waitForTimeout(400);
  }

  // ---------- the Toolbox ----------

  tile(tool: string) { return this.page.locator(`[data-pane="toolbox"] [data-tool="${tool}"]`); }

  /** A real drag of a Toolbox tile to a point; the ghost as seen over the canvas just before the drop. */
  async dragTile(tool: string, to: Pt, opts: { escape?: boolean } = {}) {
    const tile = this.tile(tool);
    await tile.scrollIntoViewIfNeeded();
    const t = (await tile.boundingBox())!;
    const { mouse } = this.page;
    await mouse.move(t.x + t.width / 2, t.y + t.height / 2);
    await mouse.down();
    await mouse.move(t.x + t.width / 2 + 30, t.y + t.height / 2 + 10, { steps: 4 });
    await mouse.move(to.x, to.y, { steps: 12 });
    await this.page.waitForTimeout(150);
    const ghost = await this.page.evaluate(() => {
      const g = document.querySelector<HTMLElement>('.tb-ghost');
      return g ? { sized: g.classList.contains('sized'), px: Number(g.dataset.px), refused: g.classList.contains('no') } : null;
    });
    if (opts.escape) await this.page.keyboard.press('Escape');
    await mouse.up();
    await this.page.waitForTimeout(500);
    return ghost;
  }

  /** Atoms made in Valence (the session's draft). */
  async made(): Promise<{ key: string; type: AtomType; row: Record<string, unknown> }[]> { return (await this.session()).created ?? []; }
  /** Arrows drawn in Valence (`kind|from|to`). */
  async added(): Promise<string[]> { return (await this.session()).added ?? []; }

  /** Drops an atom tile on empty canvas (or on the atom it needs); the new atom's key (it is pinned). */
  async make(tool: string, on: string | Pt | null = null): Promise<string> {
    const before = (await this.made()).length;
    const to = typeof on === 'string' ? await this.spot(on) : on ?? await this.empty();
    await this.dragTile(tool, to);
    const now = await this.made();
    expect(now.length, `a ${tool} made (${await this.lastLine()})`).toBe(before + 1);
    return now.at(-1)!.key;
  }

  /** Drops an arrow tile on its tail, then clicks its head. */
  async draw(tool: string, tail: string, head: string) {
    await this.dragTile(tool, await this.spot(tail));
    const h = await this.spot(head);
    await this.page.mouse.move(h.x, h.y, { steps: 6 });
    await this.page.waitForTimeout(150);
    await this.page.mouse.click(h.x, h.y);
    await this.page.waitForTimeout(400);
  }
}

/**
 * The suite's test: `v` is Valence opened fresh. After every test: nothing was written to BaseApi (only GETs and the dry
 * run left the page), and the page logged no error.
 */
export const test = base.extend<{ v: Valence }>({
  v: async ({ page }, use) => {
    const v = await Valence.open(page);
    await use(v);
    expect(v.api.writes, 'nothing written to BaseApi').toEqual([]);
    expect(v.errors, 'no page errors').toEqual([]);
  },
});
