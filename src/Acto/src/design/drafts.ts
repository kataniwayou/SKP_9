import type { History } from './history';

const KEY = 'acto.drafts';

export interface Draft { updatedAt: string | null; history: History }
export type Drafts = Record<string, Draft>;

/** Unsaved workflows only; an empty set removes the key. Answers why the write failed (a full storage), or null. */
export function writeDrafts(session: Storage | null, entries: Drafts): string | null {
  try {
    if (Object.keys(entries).length === 0) session?.removeItem(KEY);
    else session?.setItem(KEY, JSON.stringify(entries));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isState = (v: unknown): boolean => isObj(v) && typeof v.workflowId === 'string' && isObj(v.steps) && isObj(v.fields);

export function readDrafts(session: Storage | null): Drafts {
  try {
    const raw = session?.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isObj(parsed)) return {};
    const out: Drafts = {};
    for (const [id, d] of Object.entries(parsed)) {
      if (!isObj(d) || !(d.updatedAt === null || typeof d.updatedAt === 'string') || !isObj(d.history)) continue;
      const h = d.history;
      if (!isState(h.present) || !Array.isArray(h.past) || !Array.isArray(h.future) || !h.past.every(isState) || !h.future.every(isState)) continue;
      out[id] = { updatedAt: d.updatedAt as string | null, history: { ...(h as unknown as History), merge: null } };
    }
    return out;
  } catch {
    return {};
  }
}
