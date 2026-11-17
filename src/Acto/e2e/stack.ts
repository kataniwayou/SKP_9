/** BaseAPI itself (not through Vite): what global setup and teardown talk to. */
export const API = `${process.env.SKP_API ?? 'http://localhost:18080'}/api/v1`;

/** The shared stack as the run found it (global-setup.ts). */
export interface Baseline {
  startedAt: string;
  workflows: { id: string; name: string }[];
  /** Pre-existing workflows that already had a stored design (a save that failed) when the run began. */
  designed: string[];
}

export function baseline(): Baseline {
  const raw = process.env.ACTO_E2E_BASELINE;
  if (!raw) throw new Error('ACTO_E2E_BASELINE is not set: run the specs through playwright.config.ts (global-setup.ts)');
  return JSON.parse(raw) as Baseline;
}

/** The names the specs give their throwaway workflows: the board's own default, or an e2e- prefix. */
export const THROWAWAY_NAME = /^(new-workflow-\d+|e2e-[\w-]+)$/;
