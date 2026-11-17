export interface PanelSizes { tools: number; inspector: number; bottom: number; output: number | null }
export type SizeKey = keyof PanelSizes;

/** `output: null` means the Output panel takes half of the bottom row. */
export const DEFAULT_SIZES: PanelSizes = { tools: 200, inspector: 300, bottom: 190, output: null };
export const LIMITS: Record<SizeKey, readonly [number, number]> = {
  tools: [150, 340], inspector: [240, 520], bottom: [90, 420], output: [200, 900],
};
const KEY = 'acto.panels';

export function clampSize(key: SizeKey, value: number): number {
  const [lo, hi] = LIMITS[key];
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

export function readSizes(storage: Storage | null): PanelSizes {
  const out: PanelSizes = { ...DEFAULT_SIZES };
  if (!storage) return out;
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return out;
    const p: unknown = JSON.parse(raw);
    if (typeof p !== 'object' || p === null) return out;
    const o = p as Record<string, unknown>;
    for (const k of ['tools', 'inspector', 'bottom', 'output'] as const) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampSize(k, v);
    }
  } catch { /* unreadable storage or JSON: defaults */ }
  return out;
}

export function writeSizes(storage: Storage | null, s: PanelSizes): void {
  if (!storage) return;
  try { storage.setItem(KEY, JSON.stringify(s)); } catch { /* no persistence */ }
}
