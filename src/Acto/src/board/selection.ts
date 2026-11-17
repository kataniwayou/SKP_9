import type { Id } from '../model/graph';

export type Selection =
  | { kind: 'workflow'; workflowId: Id }
  | { kind: 'step'; workflowId: Id; stepId: Id }
  | { kind: 'wire'; workflowId: Id; wireId: string }
  | { kind: 'cache'; workflowId: Id; cacheId: Id };
