import type { WorkspaceState } from '../../app/workspace';
import { goneArrows } from '../../molecule/deletion';
import { arrowKey, isArrowKey, KINDS, TYPES, type Atom, type AtomType, type Molecule } from '../../molecule/model';
import type { ChatEntry } from '../chatStore';
import type { ToolContext, ToolOutcome } from '../toolTypes';

// What every tool file shares (2026-10-26): reading the arguments, finding the atom or arrow a call means, naming them,
// and the outcome shapes, with what the Output pane said while the tool ran echoed back.

/** A non-blank string argument, else undefined. */
export const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export type Found<T> = { ok: true; value: T } | { ok: false; error: string };

export const ATOM_TYPES: readonly AtomType[] = ['wf', 'step', 'proc', 'schema', 'asg', 'cache'];
const TYPE_WORDS: Readonly<Record<string, AtomType>> = {
  wf: 'wf', workflow: 'wf', step: 'step', proc: 'proc', processor: 'proc', schema: 'schema', asg: 'asg', assignment: 'asg', cache: 'cache',
};
/** A type the model wrote ("processor", "proc", …), or undefined. */
export const typeOf = (v: unknown): AtomType | undefined => (typeof v === 'string' ? TYPE_WORDS[v.trim().toLowerCase()] : undefined);

export const ATOM_ARG = {
  type: 'string',
  description: 'An atom: its key ("step:<id>"), its id, its name, or "name version". With several of one name, use the key.',
};
export const TARGET_ARG = {
  type: 'string',
  description: 'An atom (key, id, name or "name version") or an arrow (its key, "kind|tailKey|headKey", as read_atom lists it).',
};
export const TYPE_ARG = { type: 'string', enum: ['workflow', 'step', 'processor', 'schema', 'assignment', 'cache'] };

/** The name an atom shows: one typed in the Inspector, else the stored one. */
export const nameOf = (s: WorkspaceState, key: string): string => s.edits[key]?.name || s.molecule?.atoms.get(key)?.name || key;
/** "step fetch 1.0.0" */
export const labelOf = (s: WorkspaceState, key: string): string => {
  const a = s.molecule?.atoms.get(key);
  return a ? `${TYPES[a.type].label.toLowerCase()} ${nameOf(s, key)} ${s.edits[key]?.version || a.version}`.trim() : key;
};
/** "fetch → FileFetcher (Step → Processor)" */
export const arrowLabelOf = (s: WorkspaceState, key: string): string => {
  const [kind, from, to] = key.split('|') as [keyof typeof KINDS, string, string];
  return `${nameOf(s, from)} → ${nameOf(s, to)} (${KINDS[kind]?.label ?? kind})`;
};

/** What an atom is in Valence now: made and not applied, deleted, edited, or as BaseApi holds it. */
export function stateOf(s: WorkspaceState, key: string): 'new' | 'deleted' | 'edited' | 'stored' {
  if (s.created.some((c) => c.key === key)) return 'new';
  if (s.removed.atoms.includes(key)) return 'deleted';
  return s.edits[key] ? 'edited' : 'stored';
}

/** The atom a call means: its key, its id, its name or "name version" (the shown name: a typed one counts), of `type` if given. */
export function findAtom(s: WorkspaceState, ref: string, type?: AtomType): Found<Atom> {
  const m = s.molecule;
  if (!m) return { ok: false, error: 'the project is not read yet: try again in a moment' };
  const of = (atoms: Atom[]) => (type ? atoms.filter((a) => a.type === type) : atoms);
  const direct = m.atoms.get(ref);
  if (direct && (!type || direct.type === type)) return { ok: true, value: direct };
  const all = [...m.atoms.values()];
  const byId = of(all.filter((a) => a.id.toLowerCase() === ref.toLowerCase()));
  if (byId.length === 1) return { ok: true, value: byId[0]! };
  const want = ref.toLowerCase();
  const byName = of(all.filter((a) => {
    const name = nameOf(s, a.key).toLowerCase();
    return name === want || `${name} ${(s.edits[a.key]?.version || a.version).toLowerCase()}` === want;
  }));
  if (byName.length === 1) return { ok: true, value: byName[0]! };
  if (byName.length > 1) {
    return { ok: false, error: `"${ref}" is ambiguous: ${byName.map((a) => `${labelOf(s, a.key)} (${a.key})`).join(', ')}; use the key` };
  }
  return { ok: false, error: `no ${type ? TYPES[type].label.toLowerCase() : 'atom'} "${ref}" in the project (list_atoms lists them)` };
}

/** An arrow's key as the molecule has it (deleted ones too, so a delete can be undone or the arrow read). */
export function findArrow(m: Molecule, ref: string): Found<string> {
  return m.arrows.some((x) => arrowKey(x) === ref) ? { ok: true, value: ref } : { ok: false, error: `no arrow ${ref} in the project (read_atom lists an atom's arrows by key)` };
}

/** An atom or an arrow: a key with "|" is an arrow. */
export function findTarget(s: WorkspaceState, ref: string): Found<string> {
  if (!s.molecule) return { ok: false, error: 'the project is not read yet: try again in a moment' };
  if (isArrowKey(ref)) return findArrow(s.molecule, ref);
  const a = findAtom(s, ref);
  return a.ok ? { ok: true, value: a.value.key } : a;
}

/** Whether an arrow is gone in Valence (deleted alone, or with an atom at its end). */
export const isGone = (s: WorkspaceState, key: string): boolean => !!s.molecule && goneArrows(s.molecule, s.removed).has(key);

/** What the model hears is `head`, then the Output pane's lines from this call; the chat shows `action` and the same lines. */
export function done(ok: boolean, head: string, action: string, entries: ChatEntry[] = []): ToolOutcome {
  const lines = entries.flatMap((e) => (e.kind === 'output' ? [`${e.level === 'error' ? '[refused] ' : ''}${e.text}`] : []));
  return { kind: 'done', ok, result: lines.length ? `${head}\nOutput:\n${lines.join('\n')}` : head, action, entries };
}
export const fail = (error: string, action: string): ToolOutcome => done(false, error, action);

/**
 * Runs `act` and collects what the Output pane said meanwhile, as the user would read it there; `act` answers whether it
 * did what was asked, the result's first line and the chat's action line.
 */
export function acting(ctx: ToolContext, act: () => { ok: boolean; head: string; action: string }): ToolOutcome {
  const last = ctx.workspace.get().messages.at(-1)?.id ?? 0;
  const r = act();
  return done(r.ok, r.head, r.action, saidSince(ctx, last));
}

/** `acting` for a tool that waits (the apply). */
export async function actingAsync(ctx: ToolContext, act: () => Promise<{ ok: boolean; head: string; action: string }>): Promise<ToolOutcome> {
  const last = ctx.workspace.get().messages.at(-1)?.id ?? 0;
  const r = await act();
  return done(r.ok, r.head, r.action, saidSince(ctx, last));
}

const saidSince = (ctx: ToolContext, last: number): ChatEntry[] => ctx.workspace.get().messages.filter((m) => m.id > last)
  .map((m): ChatEntry => ({ kind: 'output', text: m.text, level: m.tone === 'refused' ? 'error' : 'info', name: 'Valence' }));
