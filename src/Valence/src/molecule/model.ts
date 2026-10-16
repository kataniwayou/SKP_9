import type { ProjectData } from '../api/project';

/** An atom's kind: one per entity table (the mock's TYPES; the next-step row is drawn as a stick, not an atom). */
export type AtomType = 'wf' | 'step' | 'proc' | 'schema' | 'asg' | 'cache';

/** An arrow's kind: one per foreign key (spec §5); `next` stands for the step_next_steps row. */
export type ArrowKind = 'entry' | 'wfAsg' | 'wfCache' | 'next' | 'uses' | 'asg' | 'input' | 'output' | 'config';

export interface Atom {
  /** `${type}:${row id}` */
  key: string;
  type: AtomType;
  id: string;
  name: string;
  version: string;
  /** What the hover card says about the row, line by line. */
  facts: string[];
  /** A step's entry condition (1 PreviousCompleted, 2 PreviousFailed, 3 PreviousCancelled, 4 Always); the layout reads it. */
  condition?: number;
}

export interface Arrow { from: string; to: string; kind: ArrowKind; lane: number; lanes: number }

export interface Molecule {
  atoms: Map<string, Atom>;
  arrows: Arrow[];
}

export const atomKey = (type: AtomType, id: string) => `${type}:${id}`;

/** The mock's atom styles (docs/valence/molecule-mock.html): colour, radius, label, table. */
export const TYPES: Readonly<Record<AtomType, { color: number; r: number; label: string; table: string }>> = {
  wf: { color: 0xf2c14e, r: 0.95, label: 'Workflow', table: 'workflows' },
  step: { color: 0x6c8cff, r: 0.55, label: 'Step', table: 'steps' },
  proc: { color: 0xe9e3d6, r: 0.72, label: 'Processor', table: 'processors' },
  schema: { color: 0xb48cff, r: 0.38, label: 'Schema', table: 'schemas' },
  asg: { color: 0x3fc1c9, r: 0.28, label: 'Assignment', table: 'assignments' },
  cache: { color: 0xc98a5a, r: 0.48, label: 'Cache', table: 'caches' },
};

/** Bond thickness: the database's strength of the link, thickest = hardest to break (spec §4). */
export const BOND: Readonly<Record<1 | 2 | 3 | 4, { r: number; op: number; name: string; note: string }>> = {
  1: { r: 0.08, op: 0.9, name: 'NOT NULL column', note: 'part of its row · many-to-one · cannot be cleared · RESTRICT at the target' },
  2: { r: 0.052, op: 0.85, name: 'nullable column', note: 'part of its row · many-to-one · SET NULL clears it · RESTRICT at the target' },
  3: { r: 0.034, op: 0.85, name: 'next-step row', note: 'its own row · many-to-many · DELETE removes it · RESTRICT at both ends' },
  4: { r: 0.02, op: 0.7, name: 'workflow join row', note: 'its own row · many-to-many · DELETE removes it · CASCADE when the workflow goes' },
};

/** The mock's arrow styles, with where each reference is held. */
export const KINDS: Readonly<Record<ArrowKind, { color: number; bond: 1 | 2 | 3 | 4; label: string; fk: string; where: string }>> = {
  entry: { color: 0xf2c14e, bond: 4, label: 'Workflow → entry Step', fk: 'fk_workflow_entry_steps_step_id', where: 'a row in workflow_entry_steps' },
  wfAsg: { color: 0xb59a52, bond: 4, label: 'Workflow → Assignment', fk: 'fk_workflow_assignments_assignment_id', where: 'a row in workflow_assignments' },
  wfCache: { color: 0xd9a066, bond: 4, label: 'Workflow → Cache', fk: 'fk_workflow_caches_cache_id', where: 'a row in workflow_caches' },
  next: { color: 0x7d93d8, bond: 3, label: 'Step → next Step', fk: 'fk_step_next_steps_next_step_id', where: 'a row in step_next_steps' },
  uses: { color: 0xb8b1a4, bond: 1, label: 'Step → Processor', fk: 'fk_step_processor_id', where: 'the column steps.processor_id' },
  asg: { color: 0x3fc1c9, bond: 1, label: 'Assignment → Step', fk: 'fk_assignment_step_id', where: 'the column assignments.step_id' },
  input: { color: 0x9b7be0, bond: 2, label: 'Processor → input Schema', fk: 'fk_processor_input_schema_id', where: 'the column processors.input_schema_id' },
  output: { color: 0xd3a8ff, bond: 2, label: 'Processor → output Schema', fk: 'fk_processor_output_schema_id', where: 'the column processors.output_schema_id' },
  config: { color: 0x6a5a92, bond: 2, label: 'Processor → config Schema', fk: 'fk_processor_config_schema_id', where: 'the column processors.config_schema_id' },
};

const CONDITION: Readonly<Record<number, string>> = { 1: 'PreviousCompleted', 2: 'PreviousFailed', 3: 'PreviousCancelled', 4: 'Always' };

/**
 * The whole project as a molecule: one atom per row of the six entity tables, one arrow per foreign key value, from the
 * row that holds the reference to the row it names. An arrow to a row BaseApi did not return is left out.
 */
export function buildMolecule(data: ProjectData): Molecule {
  const atoms = new Map<string, Atom>();
  const add = (type: AtomType, row: { id: string; name: string; version: string }) =>
    atoms.set(atomKey(type, row.id), { key: atomKey(type, row.id), type, id: row.id, name: row.name, version: row.version, facts: [] });
  const nameOf = (type: AtomType, id: string | null | undefined) => (id ? atoms.get(atomKey(type, id))?.name ?? '—' : '—');
  const facts = (type: AtomType, id: string, lines: string[]) => atoms.get(atomKey(type, id))!.facts.push(...lines);

  data.schemas.forEach((s) => add('schema', s));
  data.caches.forEach((c) => add('cache', c));
  data.processors.forEach((p) => add('proc', p));
  data.steps.forEach((s) => { add('step', s); atoms.get(atomKey('step', s.id))!.condition = s.entryCondition; });
  data.assignments.forEach((a) => add('asg', a));
  data.workflows.forEach((w) => add('wf', w));

  // facts that name other rows, once every row is known
  data.schemas.forEach((s) => facts('schema', s.id, [`v${s.version}`]));
  data.caches.forEach((c) => facts('cache', c.id, [`v${c.version}`, `root ${c.root}`]));
  data.processors.forEach((p) => facts('proc', p.id, [
    `v${p.version}`, `input → ${nameOf('schema', p.inputSchemaId)}`, `output → ${nameOf('schema', p.outputSchemaId)}`, `config → ${nameOf('schema', p.configSchemaId)}`]));
  data.steps.forEach((s) => facts('step', s.id, [
    `v${s.version} · enters on ${CONDITION[s.entryCondition] ?? s.entryCondition}`, `processor → ${nameOf('proc', s.processorId)}`,
    `next → ${(s.nextStepIds ?? []).map((id) => nameOf('step', id)).join(', ') || 'none'}`]));
  data.assignments.forEach((a) => facts('asg', a.id, [`v${a.version}`, `step → ${nameOf('step', a.stepId)}`]));
  data.workflows.forEach((w) => facts('wf', w.id, [
    `v${w.version} · cron ${w.cronExpression || 'not scheduled'}`, `entry → ${(w.entryStepIds ?? []).map((id) => nameOf('step', id)).join(', ') || 'none'}`,
    `caches → ${(w.cacheIds ?? []).map((id) => nameOf('cache', id)).join(', ') || 'none'}`, `assignments → ${(w.assignmentIds ?? []).length} rows`]));

  const arrows: { from: string; to: string; kind: ArrowKind }[] = [];
  const link = (from: string, to: string, kind: ArrowKind) => { if (atoms.has(from) && atoms.has(to)) arrows.push({ from, to, kind }); };
  data.workflows.forEach((w) => {
    const W = atomKey('wf', w.id);
    (w.entryStepIds ?? []).forEach((id) => link(W, atomKey('step', id), 'entry'));
    (w.assignmentIds ?? []).forEach((id) => link(W, atomKey('asg', id), 'wfAsg'));
    (w.cacheIds ?? []).forEach((id) => link(W, atomKey('cache', id), 'wfCache'));
  });
  data.steps.forEach((s) => {
    link(atomKey('step', s.id), atomKey('proc', s.processorId), 'uses');
    (s.nextStepIds ?? []).forEach((id) => link(atomKey('step', s.id), atomKey('step', id), 'next'));
  });
  data.assignments.forEach((a) => link(atomKey('asg', a.id), atomKey('step', a.stepId), 'asg'));
  data.processors.forEach((p) => {
    if (p.inputSchemaId) link(atomKey('proc', p.id), atomKey('schema', p.inputSchemaId), 'input');
    if (p.outputSchemaId) link(atomKey('proc', p.id), atomKey('schema', p.outputSchemaId), 'output');
    if (p.configSchemaId) link(atomKey('proc', p.id), atomKey('schema', p.configSchemaId), 'config');
  });

  // parallel arrows between the same pair (a processor whose input and output are one schema) fan apart
  const pairOf = (x: { from: string; to: string }) => [x.from, x.to].sort().join('|');
  const count = new Map<string, number>();
  const laned = arrows.map((x) => { const lane = count.get(pairOf(x)) ?? 0; count.set(pairOf(x), lane + 1); return { ...x, lane, lanes: 0 }; });
  laned.forEach((x) => { x.lanes = count.get(pairOf(x))!; });
  return { atoms, arrows: laned };
}

/**
 * What a workflow reaches, for highlighting: the workflow, its entry steps and every step after them, those steps'
 * processors and the processors' schemas, the workflow's assignments and caches.
 */
export function reachOf(molecule: Molecule, workflowKey: string): Set<string> {
  const reach = new Set<string>([workflowKey]);
  const out = (key: string, kinds: readonly ArrowKind[]) => molecule.arrows.filter((x) => x.from === key && kinds.includes(x.kind)).map((x) => x.to);
  const todo = out(workflowKey, ['entry']);
  for (let k = todo.shift(); k !== undefined; k = todo.shift()) {
    if (reach.has(k)) continue;
    reach.add(k);
    todo.push(...out(k, ['next']));
  }
  for (const step of [...reach].filter((k) => k.startsWith('step:'))) {
    for (const p of out(step, ['uses'])) { reach.add(p); out(p, ['input', 'output', 'config']).forEach((s) => reach.add(s)); }
  }
  out(workflowKey, ['wfAsg', 'wfCache']).forEach((k) => reach.add(k));
  return reach;
}
