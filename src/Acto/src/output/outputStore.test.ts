import { describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import { createOutputStore } from './outputStore';

describe('outputStore', () => {
  it('logs, clears and remembers the order', () => {
    const st = memoryStorage(); const o = createOutputStore(st);
    o.log('a'); o.log('b', 'warn'); expect(o.lines().map((l) => l.text)).toEqual(['a', 'b']);
    o.setNewestFirst(true); expect(createOutputStore(st).newestFirst()).toBe(true);
    o.clear(); expect(o.lines()).toEqual([]);
  });

  it('defaults to info, stamps the injected clock and notifies subscribers', () => {
    const o = createOutputStore(null, () => '12:00:01');
    const fn = vi.fn(); const off = o.subscribe(fn);
    o.log('x');
    expect(o.lines()).toEqual([{ at: '12:00:01', text: 'x', level: 'info' }]);
    expect(fn).toHaveBeenCalledTimes(1);
    off(); o.clear(); expect(fn).toHaveBeenCalledTimes(1);
    expect(o.newestFirst()).toBe(false);
  });

  it('keeps the newest 500 lines', () => {
    const o = createOutputStore(null);
    for (let i = 1; i <= 501; i++) o.log(`l${i}`);
    expect(o.lines()).toHaveLength(500);
    expect(o.lines()[0]!.text).toBe('l2');
    expect(o.lines()[499]!.text).toBe('l501');
  });
});
