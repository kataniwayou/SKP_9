import { createContext, useContext } from 'react';
import type { BoardWorkflow } from '../loadBoard';

/** The loaded workflows by id: node data carries only ids, the nodes read what they show from here. */
export const BoardContext = createContext<ReadonlyMap<string, BoardWorkflow>>(new Map());
export const useBoardWorkflow = (id: string) => useContext(BoardContext).get(id);
