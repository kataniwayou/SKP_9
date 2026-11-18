import type { Id } from '../model/graph';

/** One picked thing on the board (spec §6). Task 11 adds the behaviour (selectPick); this is the shape. */
export type Pick =
  | { kind: 'workflow'; id: Id }
  | { kind: 'step'; id: Id }
  | { kind: 'cache'; id: Id }
  | { kind: 'wire'; from: Id; to: Id }
  | { kind: 'entry'; workflowId: Id; stepId: Id }
  | { kind: 'cacheLink'; workflowId: Id; cacheId: Id };
