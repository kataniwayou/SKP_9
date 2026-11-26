/** Where the Schemas mode is remembered, per browser [user, 2026-11-26]: '1' is on, anything else off. */
const KEY = 'acto.schemas';

/** Whether the Schemas mode was left on; off when nothing is stored or the storage cannot be read. */
export function readSchemasMode(storage: Storage | null): boolean {
  try { return storage?.getItem(KEY) === '1'; } catch { return false; }
}

/** Remembers the mode; a storage that refuses is ignored. */
export function writeSchemasMode(storage: Storage | null, on: boolean): void {
  try { storage?.setItem(KEY, on ? '1' : '0'); } catch { /* not remembered */ }
}
