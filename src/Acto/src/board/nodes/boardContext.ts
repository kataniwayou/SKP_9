import { createContext, useContext } from 'react';
import type { DeletePlan } from '../../operate/deleteWorkflow';
import type { BoardWorkflow } from '../loadBoard';

/** The loaded workflows by id: node data carries only ids, the nodes read what they show from here. */
export const BoardContext = createContext<ReadonlyMap<string, BoardWorkflow>>(new Map());
export const useBoardWorkflow = (id: string) => useContext(BoardContext).get(id);

/** Present only while the board is editable. */
export interface FrameEdit { resizeFrame(wf: string, size: { w: number; h: number }, at?: { x: number; y: number }): void }
export const EditContext = createContext<FrameEdit | null>(null);
export const useBoardEdit = () => useContext(EditContext);

import type { LiveStatus } from '../../api/liveStatus';
export interface BlockStatus { unsaved: boolean; problems: number; saving: boolean; run: LiveStatus }
/** What the toolbars call and what the frame header shows; present only while the board is editable. */
export interface ToolbarActions {
  save(wf: string): void;
  start(wf: string): void;
  stop(wf: string): void;
  /** Copies the picked steps (and the one whose toolbar was used) to the clipboard. */
  copy(wf: string, step: string): void;
  deleteStep(wf: string, step: string): void;
  deleteWire(wf: string, wireId: string): void;
  /** Unlinks the cache (a cache created here and never saved is simply removed). */
  deleteCache(wf: string, cacheId: string): void;
  /** Delete workflows: the fresh live reading and the dry run first; a plan then waits for confirmRemove or cancelRemove. */
  remove(wfs: string[]): void;
  confirmRemove(): void;
  cancelRemove(): void;
  pendingRemove(): DeletePlan | null;
  status(wf: string): BlockStatus;
}
export const ToolbarContext = createContext<ToolbarActions | null>(null);
export const useToolbarActions = () => useContext(ToolbarContext);
