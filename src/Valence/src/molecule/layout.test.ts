import { describe, expect, it } from 'vitest';
import type { ProjectData } from '../api/project';
import project from '../test/fixtures/project.json';
import { extentOf, layoutMolecule } from './layout';
import { atomKey, buildMolecule, TYPES } from './model';

const data = project as ProjectData;
const m = buildMolecule(data);
const pos = layoutMolecule(m);

describe('layoutMolecule (the cluster data of 2026-10-15)', () => {
  it('places every atom at a finite point', () => {
    expect(pos.size).toBe(m.atoms.size);
    pos.forEach((p) => expect(p.every(Number.isFinite)).toBe(true));
  });

  it('is the same every time (seeded, no Math.random)', () => {
    expect([...layoutMolecule(m)]).toEqual([...pos]);
  });

  it('never puts two atoms inside each other', () => {
    const keys = [...pos.keys()];
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const a = pos.get(keys[i]!)!, b = pos.get(keys[j]!)!;
      const min = TYPES[m.atoms.get(keys[i]!)!.type].r + TYPES[m.atoms.get(keys[j]!)!.type].r;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), `${keys[i]} / ${keys[j]}`).toBeGreaterThan(min * 0.9);
    }
  });

  it('reads left to right: each next step of a flow stands to the right of the step before it, or in a hand-off row', () => {
    const w = data.workflows.find((x) => x.name === 'filefetcher-archiveexpander-chain')!;
    const entry = pos.get(atomKey('step', w.entryStepIds![0]!))!;
    const first = data.steps.find((s) => s.id === w.entryStepIds![0])!;
    const nexts = (first.nextStepIds ?? []).map((id) => pos.get(atomKey('step', id))!);
    for (const n of nexts) expect(n[0] > entry[0] || n[1] < entry[1]).toBe(true);
    // the workflow stands left of its entry step
    expect(pos.get(atomKey('wf', w.id))![0]).toBeLessThan(entry[0]);
  });

  it('is centred on the origin, and its extent holds every atom', () => {
    const c = [0, 1, 2].map((i) => [...pos.values()].reduce((s, p) => s + p[i]!, 0) / pos.size);
    for (const v of c) expect(Math.abs(v!)).toBeLessThan(1e-6);
    const r = extentOf(pos);
    pos.forEach((p) => expect(Math.hypot(...p)).toBeLessThanOrEqual(r));
  });
});
