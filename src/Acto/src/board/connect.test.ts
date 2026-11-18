import { describe, expect, it } from 'vitest';
import { board } from '../design/boardFixtures';
import { connectionKind } from './connect';

const c = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ source, sourceHandle, target, targetHandle });

describe('connectionKind', () => {
  const b = board();
  it('out → in on two steps is a wire', () => {
    expect(connectionKind(c('st:fetch', 'out', 'st:lonely', 'in'), b)).toBe('wire');
  });
  it('tip → in on a step is an entry', () => {
    expect(connectionKind(c('wf:daily', 'tip', 'st:lonely', 'in'), b)).toBe('entry');
  });
  it('back → in on a cache is a cache link', () => {
    expect(connectionKind(c('wf:hourly', 'back', 'ca:c1', 'in'), b)).toBe('cacheLink');
  });
  it('refuses everything else', () => {
    expect(connectionKind(c('st:fetch', 'out', 'wf:daily', 'tip'), b)).toBeNull();
    expect(connectionKind(c('wf:daily', 'tip', 'ca:c1', 'in'), b)).toBeNull();
    expect(connectionKind(c('wf:daily', 'back', 'st:fetch', 'in'), b)).toBeNull();
    expect(connectionKind(c('st:fetch', 'out', 'ca:c1', 'in'), b)).toBeNull();
    expect(connectionKind(c('wf:daily', 'tip', 'wf:hourly', 'in'), b)).toBeNull();
    expect(connectionKind(c('st:fetch', 'in', 'st:expand', 'in'), b)).toBeNull();
  });
  it('refuses an item the board does not have', () => {
    expect(connectionKind(c('st:ghost', 'out', 'st:fetch', 'in'), b)).toBeNull();
  });
});
