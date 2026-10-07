/**
 * A manual route (spec §4.3), Visio's "reroute as needed": a wire leaves its source and lands on its
 * target horizontally, so its path is H V H V … H. `xs` is the x of each vertical run, `ys` the y of each
 * horizontal run between two verticals (`ys.length === xs.length - 1`). The first and last horizontal
 * runs are the source's and target's heights, so they follow the blocks; everything else stays.
 */
export interface Bends {
  xs: number[];
  ys: number[];
}

/** What the user did to one wire's shape. */
export interface WireShape {
  /** A manual route; null: the router decides. */
  bends: Bends | null;
  /** Step-local landing height on the target, when slid; null: the landing rule decides. */
  landing: number | null;
}

/** A wire's two ends: the source port and the landing. */
export interface Ends {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}
