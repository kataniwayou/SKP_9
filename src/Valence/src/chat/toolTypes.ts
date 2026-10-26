import type { Highlights } from '../app/highlights';
import type { Workspace } from '../app/workspace';
import type { ChatEntry, Question } from './chatStore';

/** What a tool may use (2026-10-26): Valence's workspace (the project and its virtual changes) and the workflow filter. */
export interface ToolContext { workspace: Workspace; highlights: Highlights }

/** What a tool run came to: an answer for the model and the chat, or a question for the user first. */
export type ToolOutcome =
  | { kind: 'done'; ok: boolean; result: string; action: string; entries: ChatEntry[] }   // result: what the model hears; action: the chat's one-line action text
  | { kind: 'ask'; question: Omit<Question, 'callId'> };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema of the arguments. */
  parameters: object;
  /** `answer` is the user's choice when this call asked a question before; `pin` what that question carried. */
  run(ctx: ToolContext, args: Record<string, unknown>, answer?: string, pin?: string): Promise<ToolOutcome>;
}
