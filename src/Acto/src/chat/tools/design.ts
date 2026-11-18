import type { ToolContext, ToolDef, ToolOutcome } from '../toolTypes';
import { done, fail, linesSince, NO_ARGS, notYet } from './common';

/**
 * The design tools while the chat is rewritten for the triangle board (Plan 5 Task 13): undo and redo act on the one
 * board history; every other edit tool answers that it is not available yet.
 */
function history(ctx: ToolContext, way: 'undo' | 'redo'): ToolOutcome {
  const before = ctx.store.state();
  const mark = ctx.output.lines().at(-1);
  if (way === 'undo') ctx.store.undo(); else ctx.store.redo();
  const lines = linesSince(ctx, mark);
  const entries = lines.map((l) => ({ kind: 'output' as const, text: l.text, level: l.level, name: 'board' }));
  if (ctx.store.state() === before) return fail(lines.map((l) => l.text).join('; ') || `nothing to ${way}`, `${way} failed`, entries);
  return done(true, `${way === 'undo' ? 'undid' : 'redid'} the last change on the board`, way, entries);
}

const undo: ToolDef = {
  name: 'undo', description: "Undo the last change on the board (the one history the user's Ctrl+Z uses).",
  parameters: NO_ARGS, run: async (ctx) => history(ctx, 'undo'),
};
const redo: ToolDef = {
  name: 'redo', description: 'Redo the change last undone on the board.',
  parameters: NO_ARGS, run: async (ctx) => history(ctx, 'redo'),
};

export const DESIGN_TOOLS: ToolDef[] = [
  notYet('add_step', 'Add a step that runs a processor.'),
  notYet('set_processor', "Change a step's processor."),
  notYet('add_cache', 'Add a cache.'),
  notYet('connect', 'Wire one step to another.'),
  notYet('disconnect', 'Remove a wire.'),
  notYet('move_blocks', 'Move items on the board.'),
  notYet('pick', 'Pick items on the board.'),
  notYet('copy', 'Copy steps.'),
  notYet('paste', 'Paste copied steps.'),
  notYet('delete_picked', 'Delete what is picked.'),
  undo, redo,
];
