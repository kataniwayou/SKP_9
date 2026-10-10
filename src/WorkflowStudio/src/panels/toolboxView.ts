import { useMemo } from 'react';
import { applyEdits } from '../design/apply';
import { applyBlocks } from '../design/blocks';
import type { Cache, Graph, Processor } from '../model/graph';
import { activeDocument, type OpenDocument } from '../store/studioState';
import { useStudio } from '../store/studioStore';

/**
 * The active document's design graph (2026-10-11): its loaded workflow with the draft's blocks and the Inspector's edits,
 * as the Inspector shows it; null while nothing is loaded. The Toolbox draws an entity this design edits as the design has it.
 */
export function designGraphOf(open: OpenDocument | null): Graph | null {
  if (open === null || open.status.kind !== 'ready') return null;
  return applyEdits(applyBlocks(open.status.doc, open.design.draft.blocks), open.edits).graph;
}

/** The active document's design graph, kept while the document's design and edits stay the same. */
export function useActiveDesignGraph(): Graph | null {
  const open = useStudio(activeDocument);
  const ready = open !== null && open.status.kind === 'ready' ? open : null;
  const doc = ready && ready.status.kind === 'ready' ? ready.status.doc : null;
  const blocks = ready?.design.draft.blocks;
  const edits = ready?.edits;
  return useMemo(() => designGraphOf(ready), [doc, blocks, edits]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A Toolbox entity as shown: BaseApi's values, or the active design's when that design changed them (`unsaved`). */
export interface Shown<T> { value: T; unsaved: boolean }

/** A processor as the active design has it, when that design changed its name, version or description. */
export function overlayProcessor(p: Processor, graph: Graph | null): Shown<Processor> {
  const d = graph?.processors.get(p.id);
  if (!d || (d.name === p.name && d.version === p.version && d.description === p.description)) return { value: p, unsaved: false };
  return { value: { ...p, name: d.name, version: d.version, description: d.description }, unsaved: true };
}

/** The same items whatever their spacing (BaseApi's jsonb text and the Inspector's compact JSON differ only in form). */
function sameItems(a: string, b: string): boolean {
  if (a === b) return true;
  // jsonb also reorders keys: the same entries in any order are the same items
  const canon = (t: string) => { const v: unknown = JSON.parse(t); return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) : JSON.stringify(v); };
  try { return canon(a) === canon(b); } catch { return false; }
}

/** A cache as the active design has it, when that design changed its name, version, description, root or items. */
export function overlayCache(c: Cache, graph: Graph | null): Shown<Cache> {
  const d = graph?.caches.get(c.id);
  if (!d || (d.name === c.name && d.version === c.version && d.description === c.description && d.root === c.root && sameItems(d.items, c.items))) {
    return { value: c, unsaved: false };
  }
  return { value: { ...c, name: d.name, version: d.version, description: d.description, root: d.root, items: d.items }, unsaved: true };
}
