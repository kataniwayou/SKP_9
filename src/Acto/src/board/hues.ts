import type { Id } from '../model/graph';
import type { SelectionState } from './selection';

/** The selected workflows' colours, in selection order (then repeating). */
export const WORKFLOW_HUES: readonly string[] = ['#FF0072', '#7C3AED', '#0D9488', '#D97706', '#2563EB', '#DB2777'];

/** The hue of a selected workflow, or null when it is not selected. */
export function hueOf(selection: Pick<SelectionState, 'workflows'>, wf: Id): string | null {
  const i = selection.workflows.indexOf(wf);
  return i < 0 ? null : WORKFLOW_HUES[i % WORKFLOW_HUES.length]!;
}
