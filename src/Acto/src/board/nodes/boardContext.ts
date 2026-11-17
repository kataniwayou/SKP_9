import { createContext, useContext } from 'react';
import type { BoardWorkflow } from '../loadBoard';

/** The loaded workflows by id: node data carries only ids, the nodes read what they show from here. */
export const BoardContext = createContext<ReadonlyMap<string, BoardWorkflow>>(new Map());
export const useBoardWorkflow = (id: string) => useContext(BoardContext).get(id);

/** Present only while the board is editable. */
export interface FrameEdit { resizeFrame(wf: string, size: { w: number; h: number }, at?: { x: number; y: number }): void }
export const EditContext = createContext<FrameEdit | null>(null);
export const useBoardEdit = () => useContext(EditContext);
