import { applySummary, readiness } from '../../app/Apply';
import { summarize } from '../../app/changes';
import { DRAWABLE, MAKES } from '../../app/virtual';
import type { WorkspaceState } from '../../app/workspace';
import { canvasBridge } from '../../molecule/bridge';
import { rowOf, savedText } from '../../molecule/fields';
import type { Vec } from '../../molecule/layout';
import { KINDS, TYPES, type ArrowKind } from '../../molecule/model';
import type { ToolContext, ToolDef } from '../toolTypes';
import { acting, actingAsync, arrowLabelOf, ATOM_ARG, done, fail, findAtom, findTarget, labelOf, TARGET_ARG, text, TYPE_ARG, typeOf, type Found } from './common';

/** Pins what the user would click: the Inspector shows it and it glows (null: unpinned, as a click on empty canvas). */
const pin: ToolDef = {
  name: 'pin',
  description: 'Pins an atom or arrow, as the user\'s click does: the Inspector shows it and it glows on the canvas. Leave target out to unpin (a click on empty canvas).',
  parameters: { type: 'object', properties: { target: TARGET_ARG } },
  async run(ctx, args) {
    const ref = text(args.target);
    if (!ref) { ctx.workspace.pin(null); return done(true, 'nothing is pinned now', 'unpinned'); }
    const s = ctx.workspace.get();
    const found = findTarget(s, ref);
    if (!found.ok) return fail(found.error, `pin ${ref}`);
    ctx.workspace.pin(found.value);
    const what = found.value.includes('|') ? arrowLabelOf(s, found.value) : labelOf(s, found.value);
    return done(true, `pinned ${what}`, `pinned ${what}`);
  },
};

/** The Workflows filter on the menu strip: what the picked workflows reach stays in full, the rest fades. */
const highlightWorkflows: ToolDef = {
  name: 'highlight_workflows',
  description: 'Highlights workflows as the Workflows filter on the menu strip does: what the picked workflows reach stays in full, the rest of the molecule fades. Gives the whole pick: an empty list clears it (everything in full); add true adds to the current pick instead.',
  parameters: {
    type: 'object',
    properties: {
      workflows: { type: 'array', items: { type: 'string' }, description: 'The workflows: each a key, id, name or "name version".' },
      add: { type: 'boolean', description: 'Add these to the workflows already highlighted.' },
    },
    required: ['workflows'],
  },
  async run(ctx, args) {
    const s = ctx.workspace.get();
    if (!Array.isArray(args.workflows)) return fail('workflows must be a list', 'highlight workflows');
    const keys: string[] = [];
    for (const ref of args.workflows) {
      const w = typeof ref === 'string' ? findAtom(s, ref, 'wf') : { ok: false as const, error: 'each workflow is a text' };
      if (!w.ok) return fail(w.error, 'highlight workflows');
      keys.push(w.value.key);
    }
    const next = [...new Set([...(args.add === true ? ctx.highlights.get() : []), ...keys])];
    ctx.highlights.set(next);
    const names = next.map((k) => labelOf(s, k));
    return done(true, next.length ? `highlighted: ${names.join(', ')}` : 'no workflow is highlighted: the whole project is shown in full', next.length ? `highlighted ${names.join(', ')}` : 'cleared the highlight');
  },
};

const setField: ToolDef = {
  name: 'set_field',
  description: 'Types a field\'s value in the Inspector (pinning the atom, as the user does first). Virtual until applied; the field\'s rule judges it as typed (a problem leaves the edit unfinished, and Apply waits). The stored value again means the field is no longer edited. Text as the Inspector holds it: JSON as text, an empty text for null, a choice by its value.',
  parameters: {
    type: 'object',
    properties: { atom: ATOM_ARG, field: { type: 'string', description: 'The field\'s key as read_atom lists it (name, version, description, …).' }, value: { type: 'string' } },
    required: ['atom', 'field', 'value'],
  },
  async run(ctx, args) {
    const ref = text(args.atom), field = text(args.field);
    if (!ref || !field || typeof args.value !== 'string') return fail('atom, field and value (a text) are required', 'set field');
    const s = ctx.workspace.get();
    const a = findAtom(s, ref);
    if (!a.ok) return fail(a.error, `set ${field}`);
    const key = a.value.key;
    const spec = s.rules.table[a.value.type].find((f) => f.key === field || f.label.toLowerCase() === field.toLowerCase());
    if (!spec) return fail(`${labelOf(s, key)} has no writable field ${field}: ${s.rules.table[a.value.type].map((f) => f.key).join(', ')}`, `set ${field}`);
    if (s.removed.atoms.includes(key)) return fail(`${labelOf(s, key)} is deleted in Valence: undo the delete to edit it`, `set ${spec.key}`);
    const lock = spec.lock?.(s.molecule!, s.removed, key);
    if (lock?.locked) return fail(lock.note, `set ${spec.key} of ${labelOf(s, key)}`);
    const made = s.created.find((c) => c.key === key);
    const row = made ? made.row : rowOf(s.data!, a.value.type, a.value.id);
    if (!row) return fail(`${key} is no longer in the project`, `set ${spec.key}`);
    const before = labelOf(s, key);
    ctx.workspace.pin(key);
    ctx.workspace.edit(key, spec.key, args.value, savedText(row, spec));
    const problem = spec.check(args.value);
    return done(problem === null, problem === null ? `${spec.key} of ${before} is now ${JSON.stringify(args.value)} in Valence (not applied)` : `typed, but unfinished: ${problem}`,
      `set ${spec.key} of ${before}`);
  },
};

const revert: ToolDef = {
  name: 'revert',
  description: 'Reverts every edited field of an atom to its stored value, as the Inspector\'s Revert does (one step of the history).',
  parameters: { type: 'object', properties: { atom: ATOM_ARG }, required: ['atom'] },
  async run(ctx, args) {
    const ref = text(args.atom);
    if (!ref) return fail('atom is required', 'revert');
    const s = ctx.workspace.get();
    const a = findAtom(s, ref);
    if (!a.ok) return fail(a.error, `revert ${ref}`);
    if (!s.edits[a.value.key]) return fail(`${labelOf(s, a.value.key)} has no edited field`, `revert ${labelOf(s, a.value.key)}`);
    const label = labelOf(s, a.value.key);
    ctx.workspace.revert(a.value.key);
    return done(true, `reverted ${label}`, `reverted ${label}`);
  },
};

const remove: ToolDef = {
  name: 'delete',
  description: 'Deletes an atom or arrow in Valence, as Delete on the canvas does, under the deletion rules (a refusal says why). Virtual until applied: a ghost on the canvas, undone with undo. A deleted atom takes the deletable arrows pointing at it, and those leaving it. Deleting what was made in Valence takes it back.',
  parameters: { type: 'object', properties: { target: TARGET_ARG }, required: ['target'] },
  async run(ctx, args) {
    const ref = text(args.target);
    if (!ref) return fail('target is required', 'delete');
    const s = ctx.workspace.get();
    const found = findTarget(s, ref);
    if (!found.ok) return fail(found.error, `delete ${ref}`);
    const what = found.value.includes('|') ? arrowLabelOf(s, found.value) : labelOf(s, found.value);
    return acting(ctx, () => {
      const ok = ctx.workspace.remove(found.value);
      return { ok, head: ok ? `deleted ${what} in Valence (not applied)` : `not deleted: ${what}`, action: `delete ${what}` };
    });
  },
};

/** Where a new atom goes: beside `near` (the atom it hangs on), else beside the molecule, on the side with the most room. */
function placeFor(near: string | null): Vec {
  const places = canvasBridge.get()?.positions() ?? new Map<string, Vec>();
  const all = [...places.values()];
  const centre: Vec = all.length ? [0, 1, 2].map((i) => all.reduce((t, p) => t + p[i]!, 0) / all.length) as Vec : [0, 0, 0];
  const from = (near && places.get(near)) || centre;
  const reach = near ? 2.2 : Math.max(3, ...all.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]))) + 2;
  let best: Vec = [from[0] + reach, from[1], from[2]], room = -1;
  for (let i = 0; i < 16; i++) {
    const t = (i / 16) * Math.PI * 2, z = i % 2 ? 0.6 : -0.6;
    const p: Vec = [from[0] + reach * Math.cos(t), from[1] + reach * Math.sin(t), from[2] + z];
    const nearest = Math.min(Infinity, ...all.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])));
    if (nearest > room) { room = nearest; best = p; }
  }
  return best;
}

/** The atom a new one must hang on, found by the kind it must be (its mandatory arrow), or null for a lone kind. */
function targetFor(s: WorkspaceState, type: keyof typeof MAKES, on: string | undefined): Found<string | null> {
  const need = MAKES[type].on;
  if (!need) return { ok: true, value: null };
  if (!on) return { ok: false, error: `a new ${TYPES[type].label.toLowerCase()} hangs on a ${TYPES[need].label.toLowerCase()}: give on` };
  const t = findAtom(s, on, need);
  return t.ok ? { ok: true, value: t.value.key } : t;
}

const createAtom: ToolDef = {
  name: 'create_atom',
  description: 'Makes a new atom, as dragging a Toolbox tile does: schema, cache and processor stand alone; a step is dropped on a processor (runs on it), an assignment on a step, a workflow on a step (its entry step). Virtual until applied; placed beside what it hangs on, pinned. fields sets its fields as set_field does (name, version, …); a field left empty that its rule needs leaves it unfinished.',
  parameters: {
    type: 'object',
    properties: {
      type: TYPE_ARG,
      on: { type: 'string', description: 'The atom it hangs on (step: a processor; assignment: a step; workflow: a step). Not for schema, cache or processor.' },
      fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'Field key → text, as set_field takes them.' },
    },
    required: ['type'],
  },
  async run(ctx, args) {
    const type = typeOf(args.type);
    if (!type) return fail(`unknown kind ${String(args.type)}`, 'create');
    const s = ctx.workspace.get();
    if (!s.molecule) return fail('the project is not read yet: try again in a moment', 'create');
    const on = targetFor(s, type, text(args.on));
    if (!on.ok) return fail(on.error, `create ${TYPES[type].label.toLowerCase()}`);
    const made = acting(ctx, () => {
      const key = ctx.workspace.create(type, on.value, placeFor(on.value));
      return { ok: key !== null, head: key ? `made ${key}` : 'not made', action: `create ${TYPES[type].label.toLowerCase()}${on.value ? ` on ${labelOf(s, on.value)}` : ''}` };
    });
    if (made.kind !== 'done' || !made.ok) return made;
    const key = ctx.workspace.get().pinned!;
    const fields = typeof args.fields === 'object' && args.fields !== null ? Object.entries(args.fields as Record<string, unknown>) : [];
    const notes: string[] = [];
    for (const [field, value] of fields) {
      const r = await setField.run(ctx, { atom: key, field, value: typeof value === 'string' ? value : JSON.stringify(value) });
      if (r.kind === 'done') notes.push(r.result.split('\n')[0]!);
    }
    const now = ctx.workspace.get();
    const head = `made ${labelOf(now, key)} (${key}) in Valence (not applied)${notes.length ? `\n${notes.join('\n')}` : ''}`;
    return done(true, head, `created ${labelOf(now, key)}`, made.entries);
  },
};

const drawArrow: ToolDef = {
  name: 'draw_arrow',
  description: `Draws an arrow between two atoms already there, as an arrow tile from the Toolbox does (dropped on its tail, then its head clicked). Kinds: ${Object.entries(DRAWABLE).map(([k, d]) => `${k} (${TYPES[d!.tail].label.toLowerCase()} → ${TYPES[d!.head].label.toLowerCase()}: ${KINDS[k as ArrowKind].label})`).join(', ')}. A processor slot (input, output, config) holds one schema: delete the old arrow first. Drawing a deleted arrow again takes its delete back.`,
  parameters: {
    type: 'object',
    properties: { kind: { type: 'string', enum: Object.keys(DRAWABLE) }, tail: ATOM_ARG, head: ATOM_ARG },
    required: ['kind', 'tail', 'head'],
  },
  async run(ctx, args) {
    const kind = text(args.kind) as ArrowKind | undefined;
    const d = kind ? DRAWABLE[kind] : undefined;
    if (!kind || !d) return fail(`kind must be one of ${Object.keys(DRAWABLE).join(', ')}`, 'draw');
    const s = ctx.workspace.get();
    const tail = findAtom(s, text(args.tail) ?? '', d.tail);
    if (!tail.ok) return fail(tail.error, `draw ${kind}`);
    const head = findAtom(s, text(args.head) ?? '', d.head);
    if (!head.ok) return fail(head.error, `draw ${kind}`);
    const what = `${labelOf(s, tail.value.key)} → ${labelOf(s, head.value.key)} (${KINDS[kind].label})`;
    return acting(ctx, () => {
      const ok = ctx.workspace.draw(kind, tail.value.key, head.value.key);
      return { ok, head: ok ? `drew ${what} in Valence (not applied)` : `not drawn: ${what}`, action: `draw ${what}` };
    });
  },
};

const copyAtom: ToolDef = {
  name: 'copy_atom',
  description: 'Copies an atom, as Ctrl+C on the pinned atom does: its own values, not its arrows nor its unique fields (a cache\'s root, a processor\'s source hash). Not an arrow, a deleted atom or one with changes not applied.',
  parameters: { type: 'object', properties: { atom: ATOM_ARG }, required: ['atom'] },
  async run(ctx, args) {
    const ref = text(args.atom);
    if (!ref) return fail('atom is required', 'copy');
    const s = ctx.workspace.get();
    const a = findAtom(s, ref);
    if (!a.ok) return fail(a.error, `copy ${ref}`);
    const label = labelOf(s, a.value.key);
    return acting(ctx, () => {
      const ok = ctx.workspace.copy(a.value.key);
      return { ok, head: ok ? `copied ${label}` : `not copied: ${label}`, action: `copy ${label}` };
    });
  },
};

const paste: ToolDef = {
  name: 'paste',
  description: 'Pastes the copied atom as a new one, as Ctrl+V and a click do: a step on a processor, an assignment on a step, a workflow on a step (on); a schema, cache or processor stands alone. Only its mandatory arrow comes with it; it is pinned.',
  parameters: { type: 'object', properties: { on: { type: 'string', description: 'The atom it hangs on, when its kind needs one.' } } },
  async run(ctx, args) {
    const s = ctx.workspace.get();
    const clip = s.clipboard;
    if (!clip) return acting(ctx, () => ({ ok: ctx.workspace.canPaste(), head: 'nothing is copied: copy_atom first', action: 'paste' }));
    const on = targetFor(s, clip.type, text(args.on));
    if (!on.ok) return fail(on.error, `paste ${TYPES[clip.type].label.toLowerCase()}`);
    return acting(ctx, () => {
      const key = ctx.workspace.create(clip.type, on.value, placeFor(on.value), clip);
      return { ok: key !== null, head: key ? `pasted ${key} in Valence (not applied)` : 'not pasted', action: `paste ${clip.name || TYPES[clip.type].label.toLowerCase()}${on.value ? ` on ${labelOf(s, on.value)}` : ''}` };
    });
  },
};

const undo: ToolDef = {
  name: 'undo',
  description: 'Undoes the last change in Valence (an edit, a revert, a delete, a made atom, a drawn arrow, a paste), as Ctrl+Z does.',
  parameters: { type: 'object', properties: {} },
  async run(ctx) {
    return acting(ctx, () => { const had = ctx.workspace.get().history.past.length > 0; ctx.workspace.undo(); return { ok: had, head: had ? 'undone' : 'nothing to undo', action: 'undo' }; });
  },
};

const redo: ToolDef = {
  name: 'redo',
  description: 'Redoes the last undone change, as Ctrl+Y does.',
  parameters: { type: 'object', properties: {} },
  async run(ctx) {
    return acting(ctx, () => { const had = ctx.workspace.get().history.future.length > 0; ctx.workspace.redo(); return { ok: had, head: had ? 'redone' : 'nothing to redo', action: 'redo' }; });
  },
};

const moveAtom: ToolDef = {
  name: 'move_atom',
  description: 'Relocates an atom on the canvas, as Ctrl+drag does: beside another atom (near), or to a place (x, y, z as read_atom gives them). Its arrows follow. Only where it is drawn: nothing in the project changes, and it is no step of the history.',
  parameters: {
    type: 'object',
    properties: { atom: ATOM_ARG, near: { type: 'string', description: 'An atom to put it beside.' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
    required: ['atom'],
  },
  async run(ctx, args) {
    const canvas = canvasBridge.get();
    if (!canvas) return fail('the canvas is not shown', 'move');
    const s = ctx.workspace.get();
    const a = findAtom(s, text(args.atom) ?? '');
    if (!a.ok) return fail(a.error, 'move');
    const label = labelOf(s, a.value.key);
    let to: Vec | null = null;
    const near = text(args.near);
    if (near) {
      const n = findAtom(s, near);
      if (!n.ok) return fail(n.error, `move ${label}`);
      to = placeFor(n.value.key);
    } else if (typeof args.x === 'number' && typeof args.y === 'number') {
      to = [args.x, args.y, typeof args.z === 'number' ? args.z : canvas.positions().get(a.value.key)?.[2] ?? 0];
    }
    if (!to) return fail('give near, or x and y', `move ${label}`);
    canvas.place(new Map([[a.value.key, to]]));
    return done(true, `moved ${label} to x ${to[0].toFixed(2)}, y ${to[1].toFixed(2)}, z ${to[2].toFixed(2)}`, `moved ${label}`);
  },
};

/** What the apply would send, as one line per change, and a signature the answer checks (the changes may change meanwhile). */
function pending(ctx: ToolContext) {
  const summary = summarize(ctx.workspace.get());
  return summary ? { summary, signature: summary.rows.map((r) => `${r.mode}:${r.key}:${r.what.join(',')}`).join('|') } : null;
}

const apply: ToolDef = {
  name: 'apply_changes',
  description: 'Applies every change made in Valence to BaseApi, as Apply on the menu strip does: all of them in one transaction, or none. The user is asked first, with buttons; call it once, only when the user asked to apply.',
  parameters: { type: 'object', properties: {} },
  async run(ctx, _args, answer, pin) {
    const now = pending(ctx);
    if (!now) return fail('the project is not read yet: try again in a moment', 'apply');
    const { ready, tip } = readiness(ctx.workspace, now.summary);
    if (answer === undefined) {
      if (!ready) return fail(`Apply is not ready: ${tip}`, 'apply');
      const { rows, affects } = now.summary;
      return {
        kind: 'ask',
        question: {
          text: `Apply ${rows.length} change${rows.length === 1 ? '' : 's'} to BaseApi? All or nothing.`,
          choices: ['Apply', 'Cancel'],
          warnings: [...rows.map((r) => `${r.mode}: ${TYPES[r.type].label.toLowerCase()} ${r.name}${r.what.length ? ` — ${r.what.join(' · ')}` : ''}`),
            affects.length ? `Affects ${affects.join(', ')}.` : 'Affects no workflow.'],
          pin: now.signature,
        },
      };
    }
    if (answer !== 'Apply') return done(true, 'the user cancelled: nothing applied', 'apply cancelled');
    if (pin !== now.signature) return fail('the changes changed since the user was asked: nothing applied; ask again', 'apply: changes changed');
    if (!ready) return fail(`Apply is not ready: ${tip}`, 'apply');
    const n = now.summary.rows.length;
    return actingAsync(ctx, async () => {
      const r = await applySummary(ctx.workspace, now.summary);
      return { ok: r.applied, head: r.applied ? `applied ${n} change(s) to BaseApi` : 'nothing applied', action: r.applied ? `applied ${n} change(s)` : 'apply: nothing applied' };
    });
  },
};

export const ACT_TOOLS: ToolDef[] = [pin, highlightWorkflows, setField, revert, remove, createAtom, drawArrow, copyAtom, paste, undo, redo, moveAtom, apply];
