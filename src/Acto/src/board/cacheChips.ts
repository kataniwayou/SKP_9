import type { Point, Rect } from '../model/geometry';
import { FRAME_PAD, HEADER_H } from './geometry';

export const CHIP_W = 140;
export const CHIP_H = 28;
export const CHIP_GAP = 8;
/** The height the chip row adds to a frame that has caches. */
export const CHIP_ROW_H = 44;

/** Top-left of cache chip `index`, relative to the frame's content origin (below the header): a row along the bottom. */
export function cacheChipAt(index: number, frame: Rect): Point {
  return { x: FRAME_PAD + index * (CHIP_W + CHIP_GAP), y: frame.h - HEADER_H - FRAME_PAD - CHIP_H };
}
