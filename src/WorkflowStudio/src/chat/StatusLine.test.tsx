import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLYPHS, StatusLine } from './StatusLine';

const glyph = (c: HTMLElement) => c.querySelector('.chat-glyph')!.textContent;

describe('StatusLine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('says seconds, tokens and what the model is doing', () => {
    render(<StatusLine seconds={12} tokens={3200} activity="thinking" />);
    expect(screen.getByText('(12s · ↓ 3.2k tokens · thinking)')).toBeInTheDocument();
  });

  it('writes tokens under a thousand whole', () => {
    render(<StatusLine seconds={1} tokens={950} activity="writing" />);
    expect(screen.getByText('(1s · ↓ 950 tokens · writing)')).toBeInTheDocument();
  });

  it('cycles its glyph one step per 120 ms', () => {
    expect(GLYPHS.join(' ')).toBe('· ✢ ✳ ✶ ✻ ✽');
    const { container } = render(<StatusLine seconds={0} tokens={0} activity="waiting" />);
    expect(glyph(container)).toBe('·');
    act(() => { vi.advanceTimersByTime(120); });
    expect(glyph(container)).toBe('✢');
    act(() => { vi.advanceTimersByTime(120 * 4); });
    expect(glyph(container)).toBe('✽');
    act(() => { vi.advanceTimersByTime(120); });
    expect(glyph(container)).toBe('·');
  });

  it('holds its glyph still under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q }));
    const { container } = render(<StatusLine seconds={0} tokens={0} activity="waiting" />);
    const first = glyph(container);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(glyph(container)).toBe(first);
  });
});
