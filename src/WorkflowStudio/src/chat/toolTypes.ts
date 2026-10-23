import type { StudioApi } from '../api/client';
import type { InspectorService } from '../app/inspectorService';
import type { StudioCommands } from '../app/studioCommands';
import type { StudioStore } from '../store/studioStore';
import type { ChatEntry, Question } from './chatStore';

/** What a tool may use: the studio's store and services, the API, and the page's commands. */
export interface ToolContext { store: StudioStore; service: InspectorService; api: StudioApi; commands: StudioCommands; newId: () => string }

/** What a tool run came to: an answer for the model and the chat, or a question for the user first. */
export type ToolOutcome =
  | { kind: 'done'; ok: boolean; result: string; action: string; entries: ChatEntry[] }   // result: what the model hears; action: the chat's one-line action text
  | { kind: 'ask'; question: Omit<Question, 'callId'> };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema of the arguments. */
  parameters: object;
  /** `answer` is the user's choice when this call asked a question before. */
  run(ctx: ToolContext, args: Record<string, unknown>, answer?: string): Promise<ToolOutcome>;
}
