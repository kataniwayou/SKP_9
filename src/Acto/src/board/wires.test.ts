import { describe, expect, it } from 'vitest';
import type { Rect } from '../model/geometry';
import { conditionStyle, landings, wiresOf } from './wires';

const steps = new Map([['a', { nextStepIds: ['b', 'ghost'], entryCondition: 1 }], ['b', { nextStepIds: [], entryCondition: 2 }]]);

describe('wires', () => {
  it('makes one wire per known link, coloured by the target', () => {
    expect(wiresOf(['a', 'b'], steps)).toEqual([{ id: 'a>b', from: 'a', to: 'b', condition: 2 }]);
    expect(conditionStyle(2)).toEqual({ letter: 'F', colour: '#E0482F', name: 'Failed' });
    expect(conditionStyle(0)).toEqual({ letter: '?', colour: '#64748B', name: 'Invalid' });
  });
  it('spreads and sorts landings so fan-in does not cross', () => {
    const box = (id: string) => ({ u: { x: 0, y: 0, w: 210, h: 92 }, d: { x: 0, y: 400, w: 210, h: 92 }, t: { x: 400, y: 200, w: 210, h: 92 } } as Record<string, Rect>)[id] ?? null;
    const l = landings([{ id: 'd>t', from: 'd', to: 't', condition: 1 }, { id: 'u>t', from: 'u', to: 't', condition: 1 }], box);
    expect(l.get('u>t')!.in).toEqual({ x: 400, y: 200 + 92 * 0.22 });
    expect(l.get('d>t')!.in).toEqual({ x: 400, y: 200 + 92 * 0.78 });
    expect(l.get('u>t')!.out).toEqual({ x: 210, y: 46 });
  });
});
