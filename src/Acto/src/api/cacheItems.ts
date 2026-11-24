import { dictText, parseDict } from '../model/dict';

/**
 * A cache's items cross the API as a list of pairs (BaseApi stores them as rows since 2026-11-24); the board keeps them
 * as its dictionary text, so the conversion happens here and nowhere else.
 */
export interface CacheItemDto { key: string; value: string }

/** The pairs as the board's dictionary text, in their order; none at all is `{}`. */
export function itemsToText(items: readonly { key?: string | null; value?: string | null }[] | null | undefined): string {
  return dictText((items ?? []).map((i) => [i.key ?? '', i.value ?? ''] as const));
}

/** The board's dictionary text as pairs, in its order; text the board could not have kept throws, naming why. */
export function itemsFromText(text: string): CacheItemDto[] {
  const parsed = parseDict(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.entries.map(([key, value]) => ({ key, value }));
}
