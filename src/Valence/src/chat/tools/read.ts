import { readiness } from '../../app/Apply';
import { summarize } from '../../app/changes';
import type { WorkspaceState } from '../../app/workspace';
import { healthLine } from '../../api/liveness';
import { canvasBridge } from '../../molecule/bridge';
import { canDeleteArrow, canDeleteAtom, CONSEQUENCE } from '../../molecule/deletion';
import { detailRows, rowOf, savedText } from '../../molecule/fields';
import { arrowKey, KINDS, reachOf, TYPES, type ArrowKind } from '../../molecule/model';
import type { ToolDef } from '../toolTypes';
import { arrowLabelOf, done, fail, findAtom, findTarget, isGone, labelOf, nameOf, stateOf, TARGET_ARG, text, TYPE_ARG, typeOf } from './common';

/** A number rounded for the model: places are read, not measured. */
const r2 = (n: number) => Math.round(n * 100) / 100;

/** One atom's line in a list: key, kind, name and version, its state in Valence, and a processor's health. */
function atomLine(s: WorkspaceState, key: string): string {
  const a = s.molecule!.atoms.get(key)!;
  const state = stateOf(s, key);
  const made = state === 'new';
  const health = a.type === 'proc' ? ` | health: ${healthLine(s.liveness, a.id, made)}` : '';
  return `${key} | ${labelOf(s, key)}${state === 'stored' ? '' : ` | ${state}`}${health}`;
}

/** An arrow's line: key, what it joins, and whether it is gone or drawn in Valence. */
function arrowLine(s: WorkspaceState, key: string): string {
  const drawn = s.added.includes(key) ? ' | drawn, not applied' : '';
  return `${key} | ${arrowLabelOf(s, key)}${isGone(s, key) ? ' | deleted, not applied' : drawn}`;
}

const listAtoms: ToolDef = {
  name: 'list_atoms',
  description: 'Lists the atoms of the project (every row BaseApi holds, with what is made in Valence): key, kind, name, version, state in Valence (new, edited, deleted; nothing: as BaseApi holds it) and a processor\'s health. Filter by kind, by a workflow (what it reaches), or by a text in the name.',
  parameters: {
    type: 'object',
    properties: {
      type: { ...TYPE_ARG, description: 'Only atoms of this kind.' },
      workflow: { type: 'string', description: 'Only what this workflow reaches (its key, id, name or "name version").' },
      query: { type: 'string', description: 'Only atoms whose name contains this text (any case).' },
    },
  },
  async run(ctx, args) {
    const s = ctx.workspace.get();
    if (!s.molecule) return fail('the project is not read yet: try again in a moment', 'list atoms');
    let keys = [...s.molecule.atoms.keys()];
    const type = typeOf(args.type);
    if (args.type !== undefined && !type) return fail(`unknown kind ${String(args.type)}`, 'list atoms');
    if (type) keys = keys.filter((k) => s.molecule!.atoms.get(k)!.type === type);
    const wf = text(args.workflow);
    if (wf) {
      const w = findAtom(s, wf, 'wf');
      if (!w.ok) return fail(w.error, 'list atoms');
      const reach = reachOf(s.molecule, w.value.key);
      keys = keys.filter((k) => reach.has(k));
    }
    const q = text(args.query)?.toLowerCase();
    if (q) keys = keys.filter((k) => nameOf(s, k).toLowerCase().includes(q));
    keys.sort((a, b) => labelOf(s, a).localeCompare(labelOf(s, b)));
    const what = [type ? `${TYPES[type].label.toLowerCase()}s` : 'atoms', wf ? `of ${wf}` : '', q ? `named *${q}*` : ''].filter(Boolean).join(' ');
    return done(true, keys.length ? `${keys.length} ${what}:\n${keys.map((k) => atomLine(s, k)).join('\n')}` : `no ${what}`, `listed ${keys.length} ${what}`);
  },
};

const readAtom: ToolDef = {
  name: 'read_atom',
  description: 'Reads one atom or arrow as the Inspector shows it. An atom: its writable fields (stored value, value in Valence, the rule\'s problem, a lock), its details, its arrows out and in by key, whether Delete is allowed and what goes with it, BaseApi\'s dry-run verdict, a processor\'s health and its place on the canvas. An arrow: its ends, where it is held, whether it can be deleted and what that changes.',
  parameters: { type: 'object', properties: { target: TARGET_ARG }, required: ['target'] },
  async run(ctx, args) {
    const s = ctx.workspace.get();
    const ref = text(args.target);
    if (!ref) return fail('target is required', 'read');
    const found = findTarget(s, ref);
    if (!found.ok) return fail(found.error, `read ${ref}`);
    const m = s.molecule!;
    const key = found.value;
    if (key.includes('|')) {
      const kind = key.split('|')[0] as ArrowKind;
      const verdict = canDeleteArrow(m, s.removed, key);
      const lines = [
        `arrow ${arrowLine(s, key)}`,
        `held in: ${KINDS[kind].where}`,
        `delete: ${verdict.ok ? 'allowed' : `refused: ${verdict.reason}`}`,
        `if deleted: ${CONSEQUENCE[kind]}`,
        `pinned: ${s.pinned === key ? 'yes' : 'no'}`,
      ];
      return done(true, lines.join('\n'), `read ${arrowLabelOf(s, key)}`);
    }
    const atom = m.atoms.get(key)!;
    const made = s.created.find((c) => c.key === key);
    const row = made ? made.row : rowOf(s.data!, atom.type, atom.id);
    if (!row) return fail(`${key} is no longer in the project`, `read ${ref}`);
    const changed = s.edits[key] ?? {};
    const fields = s.rules.table[atom.type].map((spec) => {
      const stored = made ? '' : savedText(row, spec);
      const value = changed[spec.key] ?? savedText(row, spec);
      const problem = spec.check(value);
      const lock = spec.lock?.(m, s.removed, key);
      return {
        field: spec.key, label: spec.label, kind: spec.kind,
        ...(spec.options ? { options: spec.options.map((o) => `${o.value} (${o.label})`) } : {}),
        value, ...(spec.key in changed && !made ? { stored, edited: true } : {}),
        ...(problem ? { problem } : {}), ...(lock?.locked ? { locked: lock.note } : {}),
      };
    });
    const out = m.arrows.filter((x) => x.from === key).map((x) => arrowLine(s, arrowKey(x)));
    const into = m.arrows.filter((x) => x.to === key).map((x) => arrowLine(s, arrowKey(x)));
    const verdict = canDeleteAtom(m, s.removed, key);
    const dry = s.dryRun.kind === 'done' ? s.dryRun.byAtom[key] : undefined;
    const pos = canvasBridge.get()?.positions().get(key);
    const lines = [
      `atom ${atomLine(s, key)}`,
      ...(atom.type === 'proc' ? [`health: ${healthLine(s.liveness, atom.id, !!made)}`] : []),
      `fields: ${JSON.stringify(fields)}`,
      `details: ${detailRows(m, row, key).map((d) => `${d.label}: ${d.value}`).join('; ')}`,
      `arrows out:${out.length ? `\n  ${out.join('\n  ')}` : ' none'}`,
      `arrows in:${into.length ? `\n  ${into.join('\n  ')}` : ' none'}`,
      `delete: ${s.removed.atoms.includes(key) ? 'already deleted in Valence (undo brings it back)' : verdict.ok ? `allowed${verdict.taking.length ? `; ${verdict.taking.length} arrow(s) pointing at it go with it` : ''}` : `refused: ${verdict.reason}`}`,
      ...(dry ? [`BaseApi dry run: ${dry.ok ? 'passes' : `refuses: ${[...Object.entries(dry.fields).map(([f, t]) => `${f}: ${t.join(' ')}`), ...dry.other].join('; ')}`}`] : []),
      ...(pos ? [`place: x ${r2(pos[0])}, y ${r2(pos[1])}, z ${r2(pos[2])}`] : []),
      `pinned: ${s.pinned === key ? 'yes' : 'no'}`,
    ];
    return done(true, lines.join('\n'), `read ${labelOf(s, key)}`);
  },
};

const readChanges: ToolDef = {
  name: 'read_changes',
  description: 'Reads what is changed in Valence and not applied, as the Apply dialog lists it (new, updated, deleted, each with what changes and the workflows it affects), BaseApi\'s dry run of them, whether Apply is ready (and why not), and the undo and redo steps.',
  parameters: { type: 'object', properties: {} },
  async run(ctx) {
    const s = ctx.workspace.get();
    const summary = summarize(s);
    if (!summary) return fail('the project is not read yet: try again in a moment', 'read changes');
    const { ready, tip } = readiness(ctx.workspace, summary);
    const dry = s.dryRun;
    const dryLine = dry.kind === 'idle' ? 'nothing to check' : dry.kind === 'checking' ? 'BaseApi is checking' : dry.kind === 'unavailable' ? `not available: ${dry.reason}`
      : dry.ok ? `passes all ${dry.planned}` : `refuses ${dry.refused} of ${dry.planned}`;
    const lines = [
      `${summary.rows.length} change(s)${summary.affects.length ? `, affecting ${summary.affects.join(', ')}` : ''}:`,
      ...summary.rows.map((r) => `- ${r.mode}: ${TYPES[r.type].label.toLowerCase()} ${r.name} (${r.key}): ${r.what.join(' · ') || '—'}`),
      `dry run: ${dryLine}`,
      `apply: ${ready ? 'ready' : 'not ready'}: ${tip}`,
      `undo: ${s.history.past.length ? s.history.past.at(-1)!.label : 'nothing'}; redo: ${s.history.future.length ? s.history.future[0]!.label : 'nothing'}`,
    ];
    return done(true, lines.join('\n'), `read ${summary.rows.length} change(s)`);
  },
};

const readView: ToolDef = {
  name: 'read_view',
  description: 'Reads what the user sees picked: the pinned atom or arrow (the Inspector shows it), the one under the pointer, the workflows highlighted in the Workflows filter, and what is copied for paste.',
  parameters: { type: 'object', properties: {} },
  async run(ctx) {
    const s = ctx.workspace.get();
    const named = (key: string | null) => (key === null ? 'nothing' : key.includes('|') ? `arrow ${arrowLine(s, key)}` : `atom ${atomLine(s, key)}`);
    const picked = ctx.highlights.get();
    const lines = [
      `pinned: ${named(s.pinned)}`,
      `under the pointer: ${named(s.hovered)}`,
      `highlighted workflows: ${picked.length ? picked.map((k) => `${nameOf(s, k)} (${k})`).join(', ') : 'none (the whole project is shown in full)'}`,
      `copied: ${s.clipboard ? `${TYPES[s.clipboard.type].label.toLowerCase()} ${s.clipboard.name || '(no name)'}` : 'nothing'}`,
    ];
    return done(true, lines.join('\n'), 'read what is picked');
  },
};

const readOutput: ToolDef = {
  name: 'read_output',
  description: 'Reads the Output pane: what Valence did and refused (deletions, refusals with their reason, undo and redo, the dry run, apply, health changes), newest last.',
  parameters: { type: 'object', properties: { last: { type: 'integer', description: 'How many of the newest lines (default 20).' } } },
  async run(ctx, args) {
    const n = typeof args.last === 'number' && args.last > 0 ? Math.floor(args.last) : 20;
    const lines = ctx.workspace.get().messages.slice(-n).map((m) => `${m.at.slice(11, 19)} ${m.tone === 'refused' ? '[refused] ' : ''}${m.text}`);
    return done(true, lines.length ? lines.join('\n') : 'Output is empty', `read ${lines.length} Output line(s)`);
  },
};

export const READ_TOOLS: ToolDef[] = [listAtoms, readAtom, readChanges, readView, readOutput];
