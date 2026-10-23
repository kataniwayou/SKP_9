import type { CacheReadDto, ProcessorReadDto, WorkflowReadDto } from '../api/types';
import { applyDesign } from '../design/apply';
import { WORKFLOW_SOURCE } from '../layout/ports';
import type { Id } from '../model/graph';
import type { OpenDocument } from '../store/studioState';

/** The answer of a name lookup: the thing, or what to tell the model (and so the user) instead. */
export type Found<T> = { ok: true; value: T } | { ok: false; error: string };

/** What every named entity has; the DTOs' fields are optional on the wire. */
interface Named { id?: string; name?: string | null; version?: string | null }

const same = (a: string | null | undefined, b: string): boolean => (a ?? '').toLowerCase() === b.toLowerCase();
const labelOf = (x: Named): string => `${x.name ?? ''}${x.version ? ` ${x.version}` : ''}`;

/**
 * One entity out of a list by what the user or the model wrote (2026-10-23): its id, else its name (case-insensitive),
 * else "name version". Several of one name is an error that lists them all with id and version, so the model asks the
 * user which one rather than guessing.
 */
function pick<T extends Named>(items: readonly T[], ref: string, noun: string, where: string): Found<T> {
  const text = ref.trim();
  const byId = items.filter((x) => same(x.id, text));
  if (byId.length === 1) return { ok: true, value: byId[0]! };
  const byName = items.filter((x) => same(x.name, text));
  const found = byName.length > 0 ? byName : items.filter((x) => same(labelOf(x), text));
  if (found.length === 1) return { ok: true, value: found[0]! };
  if (found.length === 0) return { ok: false, error: `no ${noun} named ${text}${where}` };
  const each = found.map((x) => `${x.name ?? ''} (id ${x.id ?? '?'}${x.version ? `, version ${x.version}` : ''})`).join(', ');
  return { ok: false, error: `${found.length} ${noun}s are named ${text}: ${each}; ask the user which one` };
}

/** The steps of the design as shown: the Inspector's and the canvas's, so a step deleted in the draft is gone. */
function shownOf(doc: OpenDocument) {
  return doc.status.kind === 'ready' ? applyDesign(doc.status.doc, doc.design.draft, doc.edits) : null;
}

export function findStep(doc: OpenDocument, name: string): Found<Id> {
  const shown = shownOf(doc);
  if (shown === null) return { ok: false, error: `${doc.name} is not loaded yet` };
  const r = pick([...shown.graph.steps.values()], name, 'step', ` in ${doc.name}`);
  return r.ok ? { ok: true, value: r.value.id } : r;
}

/** A workflow by id, "name" or "name version"; the open documents too, so a new one the picker does not list yet is found. */
export function findWorkflow(list: readonly WorkflowReadDto[], open: readonly OpenDocument[], ref: string): Found<Id> {
  const all: Named[] = [...list];
  for (const d of open) if (!all.some((w) => same(w.id, d.workflowId))) all.push({ id: d.workflowId, name: d.name, version: d.version });
  const r = pick(all, ref, 'workflow', '');
  return r.ok ? { ok: true, value: r.value.id! } : r;
}

export const findProcessor = <T extends ProcessorReadDto>(list: readonly T[], ref: string): Found<T> => pick(list, ref, 'processor', '');
export const findCache = <T extends CacheReadDto>(list: readonly T[], ref: string): Found<T> => pick(list, ref, 'cache', '');

/** A wire of the design as shown, by its id or "from -> to" (steps by name or id; `workflow` is the hub). */
export function findWire(doc: OpenDocument, ref: string): Found<string> {
  const shown = shownOf(doc);
  if (shown === null) return { ok: false, error: `${doc.name} is not loaded yet` };
  const text = ref.trim();
  const byId = shown.wires.find((w) => same(w.id, text));
  if (byId) return { ok: true, value: byId.id };
  const parts = text.split(/\s*(?:->|→)\s*/);
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return { ok: false, error: `no wire ${text} in ${doc.name}; name a wire by its id or as "from -> to"` };
  const ends = (part: string): Set<string> => {
    const hub = same('workflow', part) || same(WORKFLOW_SOURCE, part) || same(shown.graph.workflow.name, part);
    const steps = [...shown.graph.steps.values()].filter((s) => same(s.id, part) || same(s.name, part)).map((s) => s.id);
    return new Set(hub ? [WORKFLOW_SOURCE, ...steps] : steps);
  };
  const tails = ends(parts[0]!), heads = ends(parts[1]!);
  const found = shown.wires.filter((w) => w.source !== null && w.target !== null && tails.has(w.source) && heads.has(w.target));
  if (found.length === 1) return { ok: true, value: found[0]!.id };
  if (found.length === 0) return { ok: false, error: `no wire from ${parts[0]} to ${parts[1]} in ${doc.name}` };
  return { ok: false, error: `${found.length} wires run from ${parts[0]} to ${parts[1]}: ${found.map((w) => w.id).join(', ')}; ask the user which one` };
}
