import { createContext, useContext } from 'react';
import { NO_VERDICT, type HealthOf } from '../api/liveness';

/** What the drawing shows of the running system (spec §5.1): the hub's run state and each processor's health. */
export interface LiveArt {
  /** The workflow's id is in `GET /orchestration/live`: the hub turns green and intact wires pulse. */
  started: boolean;
  health: HealthOf;
}

/** No live data (a test, a document still loading, a hidden tab): not started, every processor undetermined. */
export const NO_LIVE_ART: LiveArt = { started: false, health: NO_VERDICT };

export const LiveArtContext = createContext<LiveArt>(NO_LIVE_ART);

/** The live state of the canvas a node or edge is drawn in. */
export const useLiveArt = (): LiveArt => useContext(LiveArtContext);
