import type { StudioApi } from '../api/client';
import type { Pick } from '../board/picks';
import type { BoardStore } from '../design/boardStore';
import type { GhostStore } from '../design/ghosts';
import type { LiveStore } from '../live/liveClient';
import type { Point } from '../model/geometry';
import type { CacheRow } from '../design/board';
import type { Id, Processor } from '../model/graph';
import type { OutputStore } from '../output/outputStore';
import type { ChatEntry, Question } from './chatStore';

/** What the chat can ask of the page beyond the stores: the board's view and the picks. */
export interface ActoCommands {
  /** Pans the board to the workflow (and, given, the steps) the chat changed; does not change the picks. */
  focus(workflowId: Id, stepIds?: Id[]): void;
  setPicks(picks: Pick[]): void;
  picks(): Pick[];
  newWorkflowAt(): Point;            // a free spot on the board, for new_workflow
}

/**
 * What a tool may use: the board's store (the same histories the user edits), the API, Output, the live state, the
 * page's commands, the processor and cache lists as last read, the tab's session storage (the clipboard) and new ids.
 */
export interface ToolContext { store: BoardStore; api: StudioApi; output: OutputStore; live: LiveStore;
  commands: ActoCommands; processors(): Processor[]; caches(): CacheRow[]; session: Storage | null; newId: () => Id;
  /** The page's ghosts, for the chat's Save to remap their ids (saveBoard's `ghosts`). */
  ghosts?: GhostStore }

/** What a tool run came to: an answer for the model and the chat, or a question for the user first. */
export type ToolOutcome =
  | { kind: 'done'; ok: boolean; result: string; action: string; entries: ChatEntry[] }   // result: what the model hears; action: the chat's one-line action text
  | { kind: 'ask'; question: Omit<Question, 'callId'> };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema of the arguments. */
  parameters: object;
  /** `answer` is the user's choice when this call asked a question before; `pin` the workflow id that question carried. */
  run(ctx: ToolContext, args: Record<string, unknown>, answer?: string, pin?: string): Promise<ToolOutcome>;
}

/**
 * The workflow a tool acts on: `args.workflow_id`, which must name a workflow on the board now. Gone, never there or
 * not given: `no workflow <id> on the board`, for the tool to return as its failed result (nothing done).
 */
export function workflowArg(ctx: ToolContext, args: Record<string, unknown>): { id: Id; name: string } | { error: string } {
  const raw = args.workflow_id;
  if (raw === undefined || raw === null || raw === '') return { error: 'no workflow (none given) on the board' };
  const id = typeof raw === 'string' ? raw : String(raw);
  const row = typeof raw === 'string' ? ctx.store.state().workflows[id] : undefined;
  if (!row) return { error: `no workflow ${id} on the board` };
  return { id, name: row.name };
}
